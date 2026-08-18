/**
 * Testes unitários para llm-cache-operations.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type FeatureFlags } from '../../server/services/feature-flags';
import { tryResponseCache, trySemanticCache } from '../../server/services/llm-cache-operations';
import type { CacheLookupOptions } from '../../server/services/llm-cache-operations';

// Mock dependencies
vi.mock('../../server/services/ai-cache', () => ({
  aiResponseCache: {
    getAsync: vi.fn(),
  },
}));

vi.mock('../../server/services/ai-usage-tracker', () => ({
  estimateTextTokens: vi.fn(),
  estimateCost: vi.fn(),
  aiUsageTracker: {
    record: vi.fn(),
  },
}));

vi.mock('../../server/services/semantic-cache', () => ({
  semanticCacheService: {
    get: vi.fn(),
  },
  computeContextFingerprint: vi.fn(() => 'fp-test'),
}));

vi.mock('../../server/services/feature-flags', () => ({
  featureFlags: {
    getFlags: vi.fn(),
  },
}));

vi.mock('../../server/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('llm-cache-operations', () => {
  const mockOptions: CacheLookupOptions = {
    model: 'gpt-4',
    provider: 'openai',
    messages: [{ role: 'user', content: 'test' }],
    temperature: 0.7,
    maxTokens: 1000,
    responseFormat: 'text',
    operation: 'test',
    cacheContext: null,
    demandId: 1,
    requestId: 'test-123',
    routingMode: 'economic',
    routingReason: 'test-reason',
    cacheKeyVersion: 'v1',
    originalModel: 'gpt-4',
    startedAt: Date.now(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('tryResponseCache', () => {
    it('deve retornar null quando cache miss', async () => {
      const { aiResponseCache } = await import('../../server/services/ai-cache');
      vi.mocked(aiResponseCache.getAsync).mockResolvedValue(null);

      const result = await tryResponseCache('cache-key', [], mockOptions);

      expect(result).toBeNull();
      expect(aiResponseCache.getAsync).toHaveBeenCalledWith('cache-key');
    });

    it('deve retornar resultado quando cache hit', async () => {
      const { aiResponseCache } = await import('../../server/services/ai-cache');
      const { estimateTextTokens, estimateCost, aiUsageTracker } =
        await import('../../server/services/ai-usage-tracker');

      vi.mocked(aiResponseCache.getAsync).mockResolvedValue('cached response');
      vi.mocked(estimateTextTokens).mockReturnValue(10);
      vi.mocked(estimateCost).mockResolvedValue({
        listCostUsd: 0.01,
        billedCostUsd: null,
        creditAppliedUsd: null,
        pricingSource: 'static',
        pricingUpdatedAt: null,
        isEstimated: true,
      });

      const result = await tryResponseCache('cache-key', [], mockOptions);

      expect(result).not.toBeNull();
      expect(result?.content).toBe('cached response');
      expect(result?.metadata.cacheHit).toBe(true);
      expect(aiUsageTracker.record).toHaveBeenCalled();
    });
  });

  describe('trySemanticCache', () => {
    it('deve retornar null quando semantic cache desabilitado', async () => {
      const { featureFlags } = await import('../../server/services/feature-flags');
      vi.mocked(featureFlags.getFlags).mockReturnValue({
        enableSemanticCache: false,
      } as unknown as FeatureFlags);

      const result = await trySemanticCache([], mockOptions);

      expect(result).toBeNull();
    });

    it('deve retornar null quando responseFormat não é text', async () => {
      const { featureFlags } = await import('../../server/services/feature-flags');
      vi.mocked(featureFlags.getFlags).mockReturnValue({
        enableSemanticCache: true,
      } as unknown as FeatureFlags);

      const result = await trySemanticCache([], { ...mockOptions, responseFormat: 'json' });

      expect(result).toBeNull();
    });

    it('deve retornar null quando user message muito curto', async () => {
      const { featureFlags } = await import('../../server/services/feature-flags');
      vi.mocked(featureFlags.getFlags).mockReturnValue({
        enableSemanticCache: true,
      } as unknown as FeatureFlags);

      const shortMessages = [{ role: 'user', content: 'hi' }];
      const result = await trySemanticCache(shortMessages, mockOptions);

      expect(result).toBeNull();
    });

    it('deve retornar resultado quando semantic cache hit', async () => {
      const { featureFlags } = await import('../../server/services/feature-flags');
      const { semanticCacheService } = await import('../../server/services/semantic-cache');
      const { estimateTextTokens, estimateCost, aiUsageTracker } =
        await import('../../server/services/ai-usage-tracker');

      vi.mocked(featureFlags.getFlags).mockReturnValue({
        enableSemanticCache: true,
      } as unknown as FeatureFlags);
      vi.mocked(semanticCacheService.get).mockResolvedValue({
        response: 'semantic cached response',
        similarity: 0.95,
      });
      vi.mocked(estimateTextTokens).mockReturnValue(15);
      vi.mocked(estimateCost).mockResolvedValue({
        listCostUsd: 0.02,
        billedCostUsd: null,
        creditAppliedUsd: null,
        pricingSource: 'static',
        pricingUpdatedAt: null,
        isEstimated: true,
      });

      const messages = [{ role: 'user', content: 'This is a longer message for testing' }];
      const result = await trySemanticCache(messages, mockOptions);

      expect(result).not.toBeNull();
      expect(result?.content).toBe('semantic cached response');
      expect(result?.metadata.semanticCacheHit).toBe(true);
      expect(result?.metadata.semanticSimilarity).toBe(0.95);
      expect(aiUsageTracker.record).toHaveBeenCalled();
    });
  });
});
