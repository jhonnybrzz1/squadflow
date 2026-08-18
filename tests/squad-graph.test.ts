import { describe, it, expect } from 'vitest';
import type { DemandClassification } from '../server/cognitive-core/demand-classifier';
import {
  buildSquadGraph,
  linearizeSquadGraph,
  graphPreservesOrder,
  buildDeliberationGraph,
  withDeliberationNode,
  DELIBERATION_NODE_ID,
  type SquadGraph,
} from '../server/services/ai-squad/squad-graph';

function makeClassification(partial: Partial<DemandClassification> = {}): DemandClassification {
  const { criteria, ...rest } = partial;
  return {
    category: 'technical',
    confidence: 100,
    recommendedAgents: [],
    notes: '',
    personalReadiness: {
      score: 100,
      level: 'ready',
      blockers: [],
      nextQuestions: [],
      recommendation: '',
    },
    ...rest,
    criteria: {
      ambiguity: 0,
      interpretationRisk: 0,
      depthRequired: 0,
      complexity: 0,
      urgency: 0,
      ...(criteria ?? {}),
    },
  };
}

describe('buildSquadGraph', () => {
  it('cria um nó por agente, preservando a ordem', () => {
    const order = ['product_owner', 'tech_lead', 'qa'];
    const graph = buildSquadGraph(makeClassification(), order);
    expect(graph.nodes.map((n) => n.id)).toEqual(order);
    expect(graph.nodes.every((n) => n.kind === 'agent')).toBe(true);
  });

  it('emite arestas po_first do product_owner para os demais presentes', () => {
    const order = ['product_owner', 'tech_lead', 'qa'];
    const graph = buildSquadGraph(makeClassification({ category: 'analytical' }), order);
    const poEdges = graph.edges.filter((e) => e.reason === 'po_first');
    expect(poEdges).toEqual([
      { from: 'product_owner', to: 'tech_lead', reason: 'po_first' },
      { from: 'product_owner', to: 'qa', reason: 'po_first' },
    ]);
  });

  it('emite tech_lead_before_qa apenas em demanda técnica', () => {
    const order = ['tech_lead', 'qa'];
    const tech = buildSquadGraph(makeClassification({ category: 'technical' }), order);
    expect(tech.edges).toContainEqual({
      from: 'tech_lead',
      to: 'qa',
      reason: 'tech_lead_before_qa',
    });

    const biz = buildSquadGraph(makeClassification({ category: 'business' }), order);
    expect(biz.edges.some((e) => e.reason === 'tech_lead_before_qa')).toBe(false);
  });

  it('em business, mantém pm_first consistente e descarta a aresta contraditória PO→PM', () => {
    // ordem onde PM já vem antes de PO (como o sort de business produz)
    const order = ['product_manager', 'product_owner', 'qa'];
    const graph = buildSquadGraph(makeClassification({ category: 'business' }), order);

    // PM → PO e PM → qa existem (pm_first)
    expect(graph.edges).toContainEqual({
      from: 'product_manager',
      to: 'product_owner',
      reason: 'pm_first_business',
    });
    // PO → PM NÃO existe (seria inconsistente com a ordem → descartada, sem ciclo)
    expect(graph.edges.some((e) => e.from === 'product_owner' && e.to === 'product_manager')).toBe(
      false,
    );
  });

  it('em alta complexidade, todos apontam para scrum_master (uma aresta por par)', () => {
    const order = ['product_owner', 'tech_lead', 'scrum_master'];
    const graph = buildSquadGraph(
      makeClassification({ category: 'technical', criteria: { complexity: 85 } as never }),
      order,
    );
    // Todos os predecessores têm aresta para scrum_master; o par product_owner→scrum_master
    // já foi criado por po_first (dedup por par, primeira razão vence).
    const intoScrum = graph.edges.filter((e) => e.to === 'scrum_master');
    expect(intoScrum.map((e) => e.from).sort()).toEqual(['product_owner', 'tech_lead']);
    expect(intoScrum).toContainEqual({
      from: 'tech_lead',
      to: 'scrum_master',
      reason: 'scrum_master_last',
    });
    expect(intoScrum).toContainEqual({
      from: 'product_owner',
      to: 'scrum_master',
      reason: 'po_first',
    });
  });

  it('não emite arestas inconsistentes com a ordem (acíclico por construção)', () => {
    const order = ['product_owner', 'tech_lead', 'qa'];
    const graph = buildSquadGraph(makeClassification(), order);
    const rank = new Map(order.map((id, i) => [id, i]));
    for (const edge of graph.edges) {
      expect(rank.get(edge.from)!).toBeLessThan(rank.get(edge.to)!);
    }
  });
});

describe('linearizeSquadGraph', () => {
  it('respeita as arestas mesmo contra o desempate', () => {
    const graph: SquadGraph = {
      nodes: [
        { id: 'a', kind: 'agent' },
        { id: 'b', kind: 'agent' },
      ],
      edges: [{ from: 'b', to: 'a', reason: 'po_first' }],
    };
    // tieBreak diria [a, b], mas a aresta b→a força b antes de a
    expect(linearizeSquadGraph(graph, ['a', 'b'])).toEqual(['b', 'a']);
  });

  it('guarda de ciclo: devolve todos os nós sem travar', () => {
    const graph: SquadGraph = {
      nodes: [
        { id: 'a', kind: 'agent' },
        { id: 'b', kind: 'agent' },
      ],
      edges: [
        { from: 'a', to: 'b', reason: 'po_first' },
        { from: 'b', to: 'a', reason: 'po_first' },
      ],
    };
    const out = linearizeSquadGraph(graph, ['a', 'b']);
    expect([...out].sort()).toEqual(['a', 'b']);
  });
});

describe('composição dinâmica (slice 4)', () => {
  it('anota inclusion: classifier_recommended vs orchestration_added', () => {
    // product_owner está na ordem mas NÃO foi recomendado (entrou por regra de nível)
    const order = ['product_owner', 'tech_lead'];
    const graph = buildSquadGraph(makeClassification({ recommendedAgents: ['tech_lead'] }), order);
    const byId = new Map(graph.nodes.map((n) => [n.id, n.inclusion]));
    expect(byId.get('product_owner')).toBe('orchestration_added');
    expect(byId.get('tech_lead')).toBe('classifier_recommended');
  });

  it('lista como excluded os recomendados podados da ordem final', () => {
    const order = ['tech_lead', 'qa'];
    const graph = buildSquadGraph(
      makeClassification({
        recommendedAgents: ['tech_lead', 'qa', 'analista_de_dados'],
      }),
      order,
    );
    expect(graph.composition?.excluded).toEqual([
      { id: 'analista_de_dados', reason: 'level_filtered' },
    ]);
  });

  it('reflete o nível de refinamento (e cai para 3 sem triagem)', () => {
    const withLevel = buildSquadGraph(
      makeClassification({
        recommendedAgents: ['product_owner'],
        progressiveRefinement: {
          recommendedLevel: 1,
          impact: 'low',
          risk: 'low',
          complexity: 'low',
        },
      }),
      ['product_owner'],
    );
    expect(withLevel.composition?.level).toBe(1);

    const noTriage = buildSquadGraph(makeClassification(), ['tech_lead', 'qa']);
    expect(noTriage.composition?.level).toBe(3);
  });

  it('é puramente aditivo: não altera nós/arestas nem a invariante do slice 3', () => {
    const order = ['product_owner', 'tech_lead', 'qa'];
    const classification = makeClassification({ recommendedAgents: ['tech_lead', 'qa'] });
    const graph = buildSquadGraph(classification, order);
    // conjunto e ordem de nós intactos
    expect(graph.nodes.map((n) => n.id)).toEqual(order);
    // invariante de equivalência preservada
    expect(graphPreservesOrder(classification, order)).toBe(true);
    expect(linearizeSquadGraph(graph, order)).toEqual(order);
  });
});

describe('nó de deliberação / roundtable (slice 5)', () => {
  it('buildDeliberationGraph cria um sink com aresta feeds_deliberation de cada participante', () => {
    const graph = buildDeliberationGraph(['product_owner', 'tech_lead', 'qa']);
    const sink = graph.nodes.find((n) => n.kind === 'deliberation');
    expect(sink?.id).toBe(DELIBERATION_NODE_ID);
    expect(graph.nodes.filter((n) => n.kind === 'agent').map((n) => n.id)).toEqual([
      'product_owner',
      'tech_lead',
      'qa',
    ]);
    expect(graph.edges).toEqual([
      { from: 'product_owner', to: DELIBERATION_NODE_ID, reason: 'feeds_deliberation' },
      { from: 'tech_lead', to: DELIBERATION_NODE_ID, reason: 'feeds_deliberation' },
      { from: 'qa', to: DELIBERATION_NODE_ID, reason: 'feeds_deliberation' },
    ]);
  });

  it('buildDeliberationGraph deduplica participantes', () => {
    const graph = buildDeliberationGraph(['qa', 'qa', 'tech_lead']);
    expect(graph.nodes.filter((n) => n.kind === 'agent').map((n) => n.id)).toEqual([
      'qa',
      'tech_lead',
    ]);
    expect(graph.edges.filter((e) => e.from === 'qa')).toHaveLength(1);
  });

  it('o nó de deliberação não entra na linearização (invariante do slice 3 preservada)', () => {
    const order = ['product_owner', 'tech_lead', 'qa'];
    const base = buildSquadGraph(makeClassification(), order);
    const withDelib = withDeliberationNode(base, order);
    // sink presente, mas a linearização continua sendo só os agentes na ordem
    expect(withDelib.nodes.some((n) => n.kind === 'deliberation')).toBe(true);
    expect(linearizeSquadGraph(withDelib, order)).toEqual(order);
  });

  it('withDeliberationNode é idempotente e só liga agentes presentes', () => {
    const order = ['tech_lead', 'qa'];
    const base = buildSquadGraph(makeClassification(), order);
    // 'ux_designer' não é nó do grafo → não gera aresta
    const once = withDeliberationNode(base, ['tech_lead', 'qa', 'ux_designer']);
    expect(once.edges.filter((e) => e.reason === 'feeds_deliberation').map((e) => e.from)).toEqual([
      'tech_lead',
      'qa',
    ]);
    // segunda aplicação não duplica o nó nem as arestas
    const twice = withDeliberationNode(once, ['tech_lead', 'qa']);
    expect(twice.nodes.filter((n) => n.kind === 'deliberation')).toHaveLength(1);
    expect(twice).toBe(once);
  });
});

describe('invariante de equivalência (slice 3)', () => {
  const cases: Array<{ name: string; classification: DemandClassification; order: string[] }> = [
    {
      name: 'técnica completa',
      classification: makeClassification({ category: 'technical' }),
      order: ['product_owner', 'tech_lead', 'qa', 'ux_designer', 'scrum_master', 'product_manager'],
    },
    {
      name: 'business PM primeiro',
      classification: makeClassification({ category: 'business' }),
      order: ['product_manager', 'product_owner', 'qa'],
    },
    {
      name: 'alta complexidade scrum no fim',
      classification: makeClassification({
        category: 'technical',
        criteria: { complexity: 90 } as never,
      }),
      order: ['product_owner', 'tech_lead', 'qa', 'scrum_master'],
    },
    {
      name: 'nível 1 só PO',
      classification: makeClassification({ category: 'support' }),
      order: ['product_owner'],
    },
    {
      name: 'sem product_owner',
      classification: makeClassification({ category: 'analytical' }),
      order: ['analista_de_dados', 'tech_lead', 'qa'],
    },
  ];

  for (const { name, classification, order } of cases) {
    it(`linearize(build(c, order)) === order — ${name}`, () => {
      const linearized = linearizeSquadGraph(buildSquadGraph(classification, order), order);
      expect(linearized).toEqual(order);
      expect(graphPreservesOrder(classification, order)).toBe(true);
    });
  }
});
