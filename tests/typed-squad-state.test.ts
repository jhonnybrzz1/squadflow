import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContextBuilder } from '../server/services/context-builder';
import { featureFlags } from '../server/services/feature-flags';
import type { Demand } from '@shared/schema';

const demand = (id: number): Demand => ({
  id,
  title: 'Teste',
  description: 'Demanda sem repositório especificado.',
  type: 'melhoria',
  priority: 'alta',
  status: 'processing',
  progress: 0,
  refinementType: 'business',
  createdAt: new Date(),
});

describe('Estado tipado da squad (Fase 5 / slices 1-2)', () => {
  let cb: ContextBuilder;

  beforeEach(() => {
    vi.restoreAllMocks();
    cb = new ContextBuilder();
  });

  it('slice 1: captura **Recomendação:** como decisão tipada', async () => {
    await cb.buildContext(demand(1));
    cb.addAgentInsight(1, 'qa', '**Análise:** ok\n**Recomendação:** adicionar testes de borda');

    const decisions = cb.getDecisions(1);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].agentName).toBe('qa');
    expect(decisions[0].text).toContain('Recomendação');
  });

  it('slice 1: recordDecision/recordDivergence explícitos', async () => {
    await cb.buildContext(demand(2));
    cb.recordDecision(2, 'tech_lead', 'usar fila assíncrona');
    cb.recordDivergence(2, 'ux', 'prefere modal a página');

    expect(cb.getDecisions(2)[0].text).toBe('usar fila assíncrona');
    expect(cb.getDivergences(2)[0].text).toBe('prefere modal a página');
  });

  it('slice 2: retenção por saliência preserva a Recomendação após muitas linhas', async () => {
    await cb.buildContext(demand(3));
    const insight = [
      '- a',
      '- b',
      '- c',
      '- d',
      '- e',
      '- f',
      '- g',
      '- h',
      '- i',
      '**Recomendação:** usar cache distribuído',
    ].join('\n');
    cb.addAgentInsight(3, 'tech_lead', insight);

    // Sem a retenção por saliência, a Recomendação (10ª linha) seria cortada pelo slice(0,8).
    expect(cb.getEvolvedContext(3)).toContain('**Recomendação:** usar cache distribuído');
  });

  it('slice 2: superfície de decisões no contexto só com a flag ligada', async () => {
    await cb.buildContext(demand(4));
    cb.addAgentInsight(4, 'qa', '**Recomendação:** testar erro de servidor');

    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({ typedStateContextEnabled: false });
    expect(cb.getEvolvedContext(4)).not.toContain('DECISÕES DA SQUAD');

    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({ typedStateContextEnabled: true });
    const ctx = cb.getEvolvedContext(4);
    expect(ctx).toContain('DECISÕES DA SQUAD');
    expect(ctx).toContain('testar erro de servidor');
  });

  it('item 1: deduplica decisão idêntica repetida a cada turno', async () => {
    await cb.buildContext(demand(5));
    for (let turn = 0; turn < 5; turn++) {
      cb.addAgentInsight(5, 'tech_lead', '**Recomendação:** usar cache distribuído');
    }
    // 5 turnos com a mesma recomendação colapsam em 1 entrada (era O(turnos) antes).
    expect(cb.getDecisions(5)).toHaveLength(1);

    // dedupe ignora espaçamento/caixa
    cb.recordDecision(5, 'tech_lead', '**Recomendação:**   USAR CACHE DISTRIBUÍDO');
    expect(cb.getDecisions(5)).toHaveLength(1);

    // uma decisão genuinamente diferente é mantida
    cb.recordDecision(5, 'tech_lead', 'adotar fila assíncrona');
    expect(cb.getDecisions(5)).toHaveLength(2);
  });

  it('item 1: aplica teto mantendo as decisões mais recentes', async () => {
    await cb.buildContext(demand(6));
    for (let i = 0; i < 20; i++) {
      cb.recordDecision(6, 'tech_lead', `decisão número ${i}`);
    }

    const decisions = cb.getDecisions(6);
    expect(decisions).toHaveLength(12);
    // a mais antiga (0..7) foi descartada; as 12 mais recentes (8..19) sobrevivem
    expect(decisions[0].text).toBe('decisão número 8');
    expect(decisions[decisions.length - 1].text).toBe('decisão número 19');
  });

  it('item 1: bloco tipado fica limitado em run longo (controle de token)', async () => {
    await cb.buildContext(demand(7));
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({ typedStateContextEnabled: true });

    for (let turn = 0; turn < 40; turn++) {
      cb.addAgentInsight(7, 'tech_lead', `**Decisão:** escolha estratégica do turno ${turn}`);
    }

    const ctx = cb.getEvolvedContext(7);
    // conta só as linhas do bloco tipado (prefixo "- [agente]"), não o bloco de insights
    const typedBlockLines = ctx
      .split('\n')
      .filter((line) => line.startsWith('- [tech_lead]') && line.includes('escolha estratégica'));
    expect(typedBlockLines.length).toBeLessThanOrEqual(12);
    // a decisão mais recente sempre é preservada
    expect(ctx).toContain('escolha estratégica do turno 39');
  });

  it('rodada 3: aplica teto hard de 20 insights preservando os mais recentes', async () => {
    await cb.buildContext(demand(8));
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
      enableContextSummarization: false,
      typedStateContextEnabled: false,
      contextEngineeringEnabled: false,
    });

    for (let turn = 0; turn < 25; turn++) {
      cb.addAgentInsight(8, 'qa', `insight-${turn}`);
    }

    const insights = cb.getAgentInsights(8, 'qa');
    expect(insights).toHaveLength(20);
    expect(insights[0]).toBe('insight-5');
    expect(insights.at(-1)).toBe('insight-24');
  });

  it('CRIT-4: setExternalContext/appendExternalContext chegam a getEvolvedContext', async () => {
    await cb.buildContext(demand(9));

    cb.setExternalContext(9, '--- CONTEXTO RAG DE REFINAMENTOS ANTERIORES ---\nRAG X');
    expect(cb.getEvolvedContext(9)).toContain('RAG X');

    cb.appendExternalContext(9, '--- PHASE 0 BRIEF ---\nBrief Y');
    const ctx = cb.getEvolvedContext(9);
    expect(ctx).toContain('Brief Y');
    expect(ctx).toContain('RAG X');
    // o append prefixa (brief chega antes do RAG já definido)
    expect(ctx.indexOf('Brief Y')).toBeLessThan(ctx.indexOf('RAG X'));
  });

  it('aplica teto duro ao texto final preservando início e cauda', () => {
    const context = `INICIO-${'a'.repeat(60_000)}-FIM`;
    const capped = cb.capContext(context);

    expect(capped.length).toBe(48_000);
    expect(capped).toMatch(/^INICIO-/);
    expect(capped).toContain('CONTEXTO INTERMEDIÁRIO OMITIDO PELO TETO');
    expect(capped).toMatch(/-FIM$/);
  });
});
