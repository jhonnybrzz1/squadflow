import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../server/services/rerank-telemetry', () => ({
  rerankTelemetryService: {
    hashQuery: vi.fn((q: string) => `h${q.length}`),
    assignABGroup: vi.fn(() => 'rerank'),
    recordEvent: vi.fn(async () => undefined),
  },
}));

vi.mock('../../server/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/metrics')>();
  return {
    ...actual,
    rerankEffectiveTotal: { labels: vi.fn(() => ({ inc: vi.fn() })) },
    rerankFailureTotal: { labels: vi.fn(() => ({ inc: vi.fn() })) },
  };
});

const okResponse = () =>
  new Response(
    JSON.stringify({
      results: [{ index: 0, relevance_score: 0.9 }],
      usage: { search_units: 1 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

const DOCS = [{ content: 'doc compliance', source: 's1', artigo_ou_secao: 'a', score: 0.5 }];

describe('Guardas de custo do rerank (incidente infra 2026-07-17)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.RERANK_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'test-key';
  });

  it('cache TTL: retry da mesma query+docs NÃO paga chamada externa de novo', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { llmReorderService } = await import('../../server/services/llm-reorder');
    llmReorderService.clearResultCache();

    const query = 'consulta sobre norma de compliance e contrato do documento';
    const first = await llmReorderService.rerank(query, DOCS, { topK: 1, demandId: 13 });
    const second = await llmReorderService.rerank(query, DOCS, { topK: 1, demandId: 13 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.rerankCostUsd).toBeGreaterThan(0);
    expect(second.rerankCostUsd).toBe(0);
    expect(second.results[0].source).toBe('s1');
  });

  it('query gigante (dump de infra) é truncada antes de ir à API', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { llmReorderService } = await import('../../server/services/llm-reorder');
    llmReorderService.clearResultCache();

    const hugeQuery = 'norma compliance ' + 'log de infra '.repeat(5000); // ~65k chars
    await llmReorderService.rerank(hugeQuery, DOCS, { topK: 1 });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.query.length).toBeLessThanOrEqual(2000);
  });

  it('RERANK_MAX_DOCS default caiu para 15 (over-fetch reduzido)', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { llmReorderService } = await import('../../server/services/llm-reorder');
    llmReorderService.clearResultCache();

    const manyDocs = Array.from({ length: 30 }, (_, i) => ({
      content: `documento norma ${i}`,
      source: `s${i}`,
      artigo_ou_secao: 'a',
      score: 0.5,
    }));
    await llmReorderService.rerank('consulta sobre norma e compliance do contrato', manyDocs, {
      topK: 3,
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.documents.length).toBeLessThanOrEqual(15);
  });
});

describe('Circuit breaker de reprocessamento (387x loop)', () => {
  it('após 3 falhas consecutivas, a 4ª execução é recusada sem tocar o pipeline', async () => {
    vi.resetModules();
    vi.doMock('../../server/services/ai-squad/squad-coordinator', () => ({
      SquadCoordinator: class {
        processRoundtable = vi.fn(async () => {
          throw new Error('no such table: demands');
        });
      },
    }));
    vi.doMock('../../server/repositories/demand-repository', () => ({
      demandRepository: {
        findById: vi.fn(async (id: number) => ({
          id,
          title: 'mock',
          description: 'mock',
          type: 'analise_exploratoria',
          priority: 'baixa',
          domain: 'padrao',
          status: 'pending',
        })),
        updateStatus: vi.fn(async () => undefined),
        update: vi.fn(async () => undefined),
        markAsError: vi.fn(async () => undefined),
      },
    }));
    vi.doMock('../../server/services/orchestration-runtime', () => ({
      orchestrationRuntimeService: {
        startRun: vi.fn(() => 'run-id'),
        endRun: vi.fn(),
      },
    }));
    vi.doMock('../../server/events', () => ({
      eventBus: { publish: vi.fn() },
    }));
    // Módulo pesado — mocks superficiais para instanciar o serviço.
    vi.doMock('../../server/services/ai-squad/AgentFactory', () => ({
      AgentFactory: class {
        loadConfigurations() {
          return { agents: [], agentConfigs: {} };
        }
        getIconForAgent() {
          return '🤖';
        }
      },
      applySoloBuilderPrompt: vi.fn(),
    }));
    vi.doMock('../../server/services/ai-squad/document-generator', () => ({
      DocumentGenerator: class {},
    }));
    vi.doMock('../../server/cognitive-core/reality-based-refinement', () => ({
      RealityBasedRefinement: class {},
    }));
    vi.doMock('../../server/services/agent-tools-init', () => ({
      initializeAgentTools: vi.fn(),
    }));
    vi.doMock('../../server/frameworks', () => ({
      frameworkManager: { initialize: vi.fn(async () => undefined) },
    }));

    const { AISquadService } = await import('../../server/services/ai-squad');
    const service = new AISquadService();

    const config = { agentIds: ['a', 'b', 'c'], maxRounds: 1, refinementLevel: 1 as const };
    for (let i = 0; i < 3; i++) {
      await expect(service.processDemandRoundtable(13, config)).rejects.toThrow('no such table');
    }
    // 4ª tentativa: bloqueada pelo breaker ANTES de chamar o coordinator.
    await expect(service.processDemandRoundtable(13, config)).rejects.toThrow(/bloqueado por/);

    // Reset explícito reabre o caminho.
    service.resetFailureCooldown(13);
    await expect(service.processDemandRoundtable(13, config)).rejects.toThrow('no such table');
  });
});
