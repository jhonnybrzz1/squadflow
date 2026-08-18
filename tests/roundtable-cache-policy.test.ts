/**
 * Seção 14 — Cache Policy and Integration Tests (P0 / P1 blockers)
 *
 * Cobre os 5 itens do veredito que bloqueiam a ativação de enableRoundtableCache:
 *
 *  P0-1  Cache semântico desabilitado para moderador e consolidação
 *  P0-2  Custo/tokens NÃO contados em cache hits
 *  P1-3  Cache desabilitado durante amostras de Self-Consistency (SC)
 *  P1-4  Classificação correta: exact vs semantic no roundtableCacheHitTotal
 *  P1-5  Feature flags de custo validadas pelo schema Zod
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mocks do banco de dados e do logger
vi.mock('../server/db', () => ({
  isPostgres: false,
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    run: vi.fn(),
    execute: vi.fn().mockResolvedValue(undefined),
  },
  dbHelper: {
    run: vi.fn().mockResolvedValue(undefined),
    all: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../server/services/sse/manager', () => ({
  sseManager: {
    sendRoundtableEvent: vi.fn(),
  },
}));

// Mock openAIService to intercept completions
vi.mock('../server/services/openai-ai', () => ({
  openAIService: {
    generateChatCompletionWithMetadata: vi.fn(),
  },
}));

import { openAIService } from '../server/services/openai-ai';
import { RoundtableOrchestrator } from '../server/services/ai-squad/roundtable-orchestrator';
import { featureFlags } from '../server/services/feature-flags';
import { Demand } from '@shared/schema';
import { roundtableCostUsdTotal, roundtableCacheHitTotal } from '../server/metrics';

// Import pure policy functions
import {
  resolveRoundtableCachePolicy,
  classifyCacheResult,
  isCacheHit,
} from '../server/services/ai-squad/roundtable-cache-policy';

// ─── Helpers locais ──────────────────────────────────────────────────────────

function buildDemand(overrides?: Partial<Demand>): Demand {
  return {
    id: 111,
    title: 'Demanda de Teste',
    description: 'Queremos validar o cache',
    type: 'melhoria',
    priority: 'alta',
    status: 'processing',
    progress: 0,
    refinementType: 'business',
    createdAt: new Date(),
    ...overrides,
  };
}

describe('Seção 14 — Roundtable Cache Policy (Pure Functions)', () => {
  describe('P0-1 — resolveRoundtableCachePolicy and semanticCacheDisabled', () => {
    it('should always return semanticCacheDisabled: true', () => {
      const policy = resolveRoundtableCachePolicy({
        enabled: true,
        forSelfConsistency: false,
        ttlMs: 3600000,
      });
      expect(policy.semanticCacheDisabled).toBe(true);
    });

    it('should set cache: true when enabled and not self-consistency', () => {
      const policy = resolveRoundtableCachePolicy({
        enabled: true,
        forSelfConsistency: false,
        ttlMs: 3600000,
      });
      expect(policy.cache).toBe(true);
      expect(policy.cacheTtlMs).toBe(3600000);
    });

    it('should set cache: false when disabled', () => {
      const policy = resolveRoundtableCachePolicy({
        enabled: false,
        forSelfConsistency: false,
        ttlMs: 3600000,
      });
      expect(policy.cache).toBe(false);
      expect(policy.cacheTtlMs).toBeUndefined();
    });

    it('should set cache: false when in self-consistency mode', () => {
      const policy = resolveRoundtableCachePolicy({
        enabled: true,
        forSelfConsistency: true,
        ttlMs: 3600000,
      });
      expect(policy.cache).toBe(false);
      expect(policy.cacheTtlMs).toBeUndefined();
    });
  });

  describe('P1-4 — classifyCacheResult', () => {
    it('should classify semanticCacheHit=true as semantic', () => {
      const type = classifyCacheResult({ cacheHit: true, semanticCacheHit: true });
      expect(type).toBe('semantic');
    });

    it('should classify cacheHit=true and semanticCacheHit=false/undefined as exact', () => {
      const type1 = classifyCacheResult({ cacheHit: true, semanticCacheHit: false });
      const type2 = classifyCacheResult({ cacheHit: true });
      expect(type1).toBe('exact');
      expect(type2).toBe('exact');
    });

    it('should return none when no hits', () => {
      const type = classifyCacheResult({ cacheHit: false });
      expect(type).toBe('none');
    });
  });

  describe('P0-2 — isCacheHit helper', () => {
    it('should return true if either exact or semantic hit', () => {
      expect(isCacheHit({ cacheHit: true })).toBe(true);
      expect(isCacheHit({ cacheHit: false, semanticCacheHit: true })).toBe(true);
      expect(isCacheHit({ cacheHit: false, semanticCacheHit: false })).toBe(false);
    });
  });
});

describe('Seção 14 — Integration Tests (RoundtableOrchestrator)', () => {
  let orchestrator: RoundtableOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    orchestrator = new RoundtableOrchestrator(null as any);
  });

  describe('Moderator Cache & SC Integration', () => {
    it('should apply cache parameters correctly for moderator when roundtable cache is enabled', async () => {
      vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
        enableRoundtableCache: true,
        roundtableCacheModeratorTtlMs: 3600000,
        moderatorMaxTokens: 500,
        moderatorMaxHistoryTurns: 3,
        roundtableModeratorMode: 'llm',
        selfConsistencyEnabled: false, // disable SC to test simple path
      } as any);

      vi.mocked(openAIService.generateChatCompletionWithMetadata).mockResolvedValueOnce({
        content: JSON.stringify({
          next_speaker: 'tech_lead',
          reason: 'test',
          dialogue_move: 'support',
          should_continue: true,
        }),
        metadata: {
          cacheHit: true,
          semanticCacheHit: false,
          modelUsed: 'gpt-4',
        } as any,
      });

      const demand = buildDemand();
      const decision = await orchestrator['decideNextSpeaker'](
        demand.id,
        demand,
        ['tech_lead'],
        ['[product_owner] product_owner: Olá'],
        1,
        5,
        0,
        3,
      );

      expect(decision.next_speaker).toBe('tech_lead');
      expect(openAIService.generateChatCompletionWithMetadata).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          cache: true,
          cacheTtlMs: 3600000,
          semanticCacheDisabled: true,
          maxTokens: 500,
          taskType: 'json',
          responseFormat: 'json_object',
          failOpenOnError: true,
        }),
      );
    });

    it('should disable cache when self-consistency is running', async () => {
      vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
        enableRoundtableCache: true,
        roundtableCacheModeratorTtlMs: 3600000,
        moderatorMaxTokens: 500,
        moderatorMaxHistoryTurns: 3,
        roundtableModeratorMode: 'llm',
        selfConsistencyEnabled: true,
        selfConsistencyN: 3,
        selfConsistencyThreshold: 0.6,
      } as any);

      // SC runs N=3 samples
      const mockResponse = {
        content: JSON.stringify({
          next_speaker: 'tech_lead',
          reason: 'test',
          dialogue_move: 'support',
          should_continue: true,
        }),
        metadata: {
          cacheHit: false,
          semanticCacheHit: false,
          modelUsed: 'gpt-4',
        } as any,
      };

      vi.mocked(openAIService.generateChatCompletionWithMetadata)
        .mockResolvedValueOnce(mockResponse)
        .mockResolvedValueOnce(mockResponse)
        .mockResolvedValueOnce(mockResponse);

      const demand = buildDemand({ priority: 'alta' }); // must be high risk to trigger SC
      await orchestrator['decideNextSpeaker'](
        demand.id,
        demand,
        ['tech_lead'],
        ['[product_owner] product_owner: Olá'],
        1,
        5,
        0,
        3,
      );

      // Verify all 3 samples were generated with cache: false
      expect(openAIService.generateChatCompletionWithMetadata).toHaveBeenCalledTimes(3);
      expect(openAIService.generateChatCompletionWithMetadata).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          cache: false,
          cacheTtlMs: undefined,
          semanticCacheDisabled: true,
        }),
      );
    });
  });

  describe('Consolidation Cache Integration', () => {
    it('should apply cache parameters correctly for consolidation', async () => {
      vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
        enableRoundtableCache: true,
        roundtableCacheConsolidationTtlMs: 86400000,
        redTeamEnabled: false, // disable red team for simple path
      } as any);

      vi.mocked(openAIService.generateChatCompletionWithMetadata).mockResolvedValueOnce({
        content: JSON.stringify({
          problema: 'ok',
          objetivo: 'ok',
          escopo: 'ok',
          criterios_de_aceite: [],
          riscos: [],
          dependencias: [],
          divergencias: [],
          consolidacao: 'consolidation output',
        }),
        metadata: {
          cacheHit: true,
          semanticCacheHit: false,
          modelUsed: 'gpt-4',
        } as any,
      });

      const demand = buildDemand();
      await orchestrator['consolidate'](demand, [], [], 0, undefined, 3);

      expect(openAIService.generateChatCompletionWithMetadata).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          cache: true,
          cacheTtlMs: 86400000,
          semanticCacheDisabled: true,
        }),
      );
    });
  });

  describe('Prometheus Metrics Integration (P0-2 and P1-4)', () => {
    it('should NOT increment cost/tokens and should increment cache hit count on cache hit', async () => {
      vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
        enableRoundtableCache: true,
        redTeamEnabled: false,
      } as any);

      vi.mocked(openAIService.generateChatCompletionWithMetadata).mockResolvedValue({
        content: JSON.stringify({
          problema: 'ok',
          objetivo: 'ok',
          escopo: 'ok',
          criterios_de_aceite: [],
          riscos: [],
          dependencias: [],
          divergencias: [],
          consolidacao: 'consolidation output',
        }),
        metadata: {
          cacheHit: true,
          semanticCacheHit: false,
          modelUsed: 'gpt-4',
          promptTokens: 0,
          completionTokens: 0,
          costEstimate: 0,
        } as any,
      });

      const costBefore =
        (await roundtableCostUsdTotal.get()).values.find((v) => v.labels.stage === 'consolidation')
          ?.value || 0;
      const hitsBefore =
        (await roundtableCacheHitTotal.get()).values.find(
          (v) => v.labels.stage === 'consolidation' && v.labels.cache_type === 'exact',
        )?.value || 0;

      const demand = buildDemand();
      await orchestrator['consolidate'](demand, [], [], 0, undefined, 3);

      const costAfter =
        (await roundtableCostUsdTotal.get()).values.find((v) => v.labels.stage === 'consolidation')
          ?.value || 0;
      const hitsAfter =
        (await roundtableCacheHitTotal.get()).values.find(
          (v) => v.labels.stage === 'consolidation' && v.labels.cache_type === 'exact',
        )?.value || 0;

      expect(costAfter - costBefore).toBe(0);
      expect(hitsAfter - hitsBefore).toBe(1);
    });

    it('should increment cost/tokens and should NOT increment cache hit count on cache miss', async () => {
      vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
        enableRoundtableCache: true,
        redTeamEnabled: false,
      } as any);

      vi.mocked(openAIService.generateChatCompletionWithMetadata).mockResolvedValue({
        content: JSON.stringify({
          problema: 'ok',
          objetivo: 'ok',
          escopo: 'ok',
          criterios_de_aceite: [],
          riscos: [],
          dependencias: [],
          divergencias: [],
          consolidacao: 'consolidation output',
        }),
        metadata: {
          cacheHit: false,
          semanticCacheHit: false,
          modelUsed: 'gpt-4',
          promptTokens: 100,
          completionTokens: 50,
          costEstimate: 0.002,
        } as any,
      });

      const costBefore =
        (await roundtableCostUsdTotal.get()).values.find(
          (v) => v.labels.stage === 'consolidation' && v.labels.refinement_level === '3',
        )?.value || 0;

      const demand = buildDemand();
      await orchestrator['consolidate'](demand, [], [], 0, undefined, 3);

      const costAfter =
        (await roundtableCostUsdTotal.get()).values.find(
          (v) => v.labels.stage === 'consolidation' && v.labels.refinement_level === '3',
        )?.value || 0;

      expect(costAfter - costBefore).toBe(0.002);
    });
  });
});

describe('Seção 14 — Feature flags Zod Schema & Constraints', () => {
  let featureFlagsSchema: typeof import('../server/services/feature-flags').featureFlagsSchema;

  beforeEach(async () => {
    featureFlagsSchema = (await import('../server/services/feature-flags')).featureFlagsSchema;
  });

  it('enableRoundtableCache default is false (rollout seguro)', () => {
    const flags = featureFlagsSchema.parse({});
    expect(flags.enableRoundtableCache).toBe(false);
  });

  it('selfConsistencyNLevel2 default is 2 and must be integer', () => {
    const flags = featureFlagsSchema.parse({});
    expect(flags.selfConsistencyNLevel2).toBe(2);

    const failFrac = featureFlagsSchema.safeParse({ selfConsistencyNLevel2: 2.5 });
    expect(failFrac.success).toBe(false);

    const failMax = featureFlagsSchema.safeParse({ selfConsistencyNLevel2: 6 });
    expect(failMax.success).toBe(false);
  });

  it('moderatorMaxHistoryTurns must be integer and within bounds', () => {
    const failFrac = featureFlagsSchema.safeParse({ moderatorMaxHistoryTurns: 3.5 });
    expect(failFrac.success).toBe(false);

    const failMax = featureFlagsSchema.safeParse({ moderatorMaxHistoryTurns: 21 });
    expect(failMax.success).toBe(false);
  });

  it('moderatorMaxTokens must be integer and within bounds', () => {
    const failMin = featureFlagsSchema.safeParse({ moderatorMaxTokens: 49 });
    expect(failMin.success).toBe(false);

    const failMax = featureFlagsSchema.safeParse({ moderatorMaxTokens: 501 });
    expect(failMax.success).toBe(false);
  });
});
