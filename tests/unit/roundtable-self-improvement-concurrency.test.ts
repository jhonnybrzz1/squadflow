import { describe, expect, it, vi, beforeEach } from 'vitest';

const extractPatternsMock = vi.hoisted(() => vi.fn(() => []));

vi.mock('../../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../server/services/sse/manager', () => ({
  sseManager: { sendRoundtableEvent: vi.fn() },
}));

vi.mock('../../server/services/openai-ai', () => ({
  openAIService: { generateChatCompletionWithMetadata: vi.fn() },
}));

vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: {
    findById: vi.fn(),
    findByIdOrNull: vi.fn(),
    updateChat: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock('../../server/services/ai-squad/self-improvement-extractor', () => ({
  extractPatterns: extractPatternsMock,
}));

vi.mock('../../server/services/llm-audit-log', () => ({
  llmAuditLogService: {
    recordSelfImprovementPattern: vi.fn(),
  },
}));

import { openAIService } from '../../server/services/openai-ai';
import { demandRepository } from '../../server/repositories/demand-repository';
import { RoundtableOrchestrator } from '../../server/services/ai-squad/roundtable-orchestrator';
import { featureFlags } from '../../server/services/feature-flags';

describe('RoundtableOrchestrator self-improvement concurrency (#10140)', () => {
  function buildDemand(id: number) {
    return {
      id,
      title: `Demanda ${id}`,
      description: `desc ${id}`,
      type: 'melhoria',
      priority: 'media',
      status: 'processing',
      progress: 0,
      refinementType: 'business',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    extractPatternsMock.mockReturnValue([]);

    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
      roundtableModeratorMode: 'llm',
      enableParallelAgents: false,
      enableDynamicAgentEscalation: false,
      selfConsistencyEnabled: false,
      enableRoundtableCache: false,
    } as any);

    vi.mocked(demandRepository.findById).mockImplementation(
      async (id: number) => buildDemand(id) as any,
    );
    vi.mocked(demandRepository.findByIdOrNull).mockResolvedValue({ chatMessages: [] } as any);

    // Moderador encerra após o primeiro turno; agente e consolidação retornam
    // conteúdo marcado com o demandId para verificar isolamento.
    vi.mocked(openAIService.generateChatCompletionWithMetadata).mockImplementation(
      async (_system, _user, options: any) => {
        const demandId = options.demandId;
        if (options.operation === 'roundtable:moderator') {
          return {
            content: JSON.stringify({
              next_speaker: 'product_owner',
              reason: 'PO abre',
              dialogue_move: 'open',
              should_continue: false,
            }),
            metadata: {
              modelUsed: 'model-moderator',
              promptTokens: 1,
              completionTokens: 1,
              costEstimate: 0,
            },
          } as any;
        }
        if (options.operation?.startsWith('roundtable:')) {
          return {
            content: JSON.stringify({
              type: 'response',
              content: `resposta-da-demanda-${demandId}`,
            }),
            metadata: {
              modelUsed: 'model-agent',
              promptTokens: 1,
              completionTokens: 1,
              costEstimate: 0,
            },
          } as any;
        }
        if (options.operation === 'roundtable:consolidation') {
          return {
            content: JSON.stringify({
              problema: `problema-${demandId}`,
              objetivo: `objetivo-${demandId}`,
              escopo: `escopo-${demandId}`,
              criterios_de_aceite: [`criterio-${demandId}`],
              riscos: [],
              dependencias: [],
              divergencias: [],
              consolidacao: `consolidacao-${demandId}`,
            }),
            metadata: {
              modelUsed: 'model-consolidation',
              promptTokens: 1,
              completionTokens: 1,
              costEstimate: 0,
            },
          } as any;
        }
        return { content: '', metadata: {} } as any;
      },
    );
  });

  it('duas runRoundTable concorrentes não misturam turnMetadata entre demandas', async () => {
    const orchestrator = new RoundtableOrchestrator({
      agentConfigs: {
        product_owner: {
          system_prompt: 'PO',
          description: 'Product Owner',
          model: 'model',
        },
      },
      isStopRequested: vi.fn(() => false),
    } as any);

    const config = { agentIds: ['product_owner'], maxRounds: 1, refinementLevel: 1 };
    const internalContext = 'ctx';

    const [result1, result2] = await Promise.all([
      orchestrator.runRoundTable(1, config, internalContext, undefined, {
        skipExtraction: false,
      } as any),
      orchestrator.runRoundTable(2, config, internalContext, undefined, {
        skipExtraction: false,
      } as any),
    ]);

    expect(result1.rounds.length).toBeGreaterThan(0);
    expect(result2.rounds.length).toBeGreaterThan(0);

    // Aguarda setImmediate do hook de self-improvement.
    await new Promise((resolve) => setImmediate(resolve));

    expect(extractPatternsMock).toHaveBeenCalledTimes(2);

    const calls = vi.mocked(extractPatternsMock).mock.calls as any[];
    const inputsByDemandId = new Map<number, any>();
    for (const [input] of calls) {
      inputsByDemandId.set(input.demandId, input);
    }

    expect(inputsByDemandId.has(1)).toBe(true);
    expect(inputsByDemandId.has(2)).toBe(true);

    for (const [demandId, input] of inputsByDemandId) {
      expect(input.turnMetadata).toBeInstanceOf(Array);
      expect(input.turnMetadata.length).toBeGreaterThan(0);
      for (const turn of input.turnMetadata) {
        expect(turn.content).toContain(`resposta-da-demanda-${demandId}`);
      }
    }
  });
});
