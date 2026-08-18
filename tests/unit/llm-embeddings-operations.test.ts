/**
 * Testes unitários para llm-embeddings-operations.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { embeddingsManager } from '../../server/services/llm-embeddings-operations';
import { llmClientManager } from '../../server/services/llm-client-manager';
import { circuitBreaker } from '../../server/services/circuit-breaker';
import { generateLocalEmbedding } from '../../server/services/llm-local-embeddings';

// Mock dependencies
vi.mock('../../server/utils/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../../server/services/llm-client-manager', () => ({
  llmClientManager: {
    getClient: vi.fn(),
    hasClient: vi.fn(),
  },
}));

vi.mock('../../server/services/llm-local-embeddings', () => ({
  generateLocalEmbedding: vi.fn(),
  hashToIndex: vi.fn(),
}));

vi.mock('../../server/services/circuit-breaker', () => ({
  circuitBreaker: {
    execute: vi.fn(),
  },
}));

vi.mock('../../server/services/llm-observability', () => ({
  errorHandlingManager: {
    sanitizeAIError: vi.fn((e) => ({ message: String(e) })),
    logSanitized: vi.fn(),
    getErrorMessage: vi.fn((e) => String(e)),
  },
}));

vi.mock('../../server/services/ai-usage-tracker', () => ({
  aiUsageTracker: { record: vi.fn() },
  estimateCost: vi.fn().mockResolvedValue({ listCostUsd: 0 }),
  estimateTextTokens: vi.fn().mockReturnValue(10),
}));

vi.mock('../../server/metrics', () => ({
  embeddingProviderTotal: { labels: vi.fn().mockReturnValue({ inc: vi.fn() }) },
  embeddingDegradedTotal: { labels: vi.fn().mockReturnValue({ inc: vi.fn() }) },
}));

describe('llm-embeddings-operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateEmbedding', () => {
    it('deve usar embedding local quando useLocal=true', async () => {
      const { generateLocalEmbedding } = await import('../../server/services/llm-local-embeddings');
      vi.mocked(generateLocalEmbedding).mockReturnValue([0.1, 0.2, 0.3]);

      const result = await embeddingsManager.generateEmbedding({
        text: 'test',
        useLocal: true,
      });

      expect(result).toEqual([0.1, 0.2, 0.3]);
      expect(generateLocalEmbedding).toHaveBeenCalledWith('test');
    });
  });

  describe('generateEmbeddings', () => {
    it('deve usar embeddings locais quando useLocal=true', async () => {
      const { generateLocalEmbedding } = await import('../../server/services/llm-local-embeddings');
      vi.mocked(generateLocalEmbedding).mockReturnValue([0.1, 0.2, 0.3]);

      const result = await embeddingsManager.generateEmbeddings({
        texts: ['test1', 'test2'],
        useLocal: true,
      });

      expect(result).toEqual([
        [0.1, 0.2, 0.3],
        [0.1, 0.2, 0.3],
      ]);
      expect(generateLocalEmbedding).toHaveBeenCalledTimes(2);
    });
  });

  // EMB-001/EMB-003: degraded state, no process.env mutation, dimension padding
  describe('EMB-001/EMB-003 — degraded state & dimension validation', () => {
    beforeEach(() => {
      // Reset transient degraded flag between tests by forcing local config
      // then restoring — the flag is private and only set on remote failure.
      vi.mocked(llmClientManager.hasClient).mockReturnValue(true);
    });

    it('isDegraded() returns false when remote is configured and no failure occurred', () => {
      const original = process.env.EMBEDDING_PROVIDER;
      process.env.EMBEDDING_PROVIDER = 'openrouter';
      try {
        expect(embeddingsManager.isDegraded()).toBe(false);
      } finally {
        if (original === undefined) delete process.env.EMBEDDING_PROVIDER;
        else process.env.EMBEDDING_PROVIDER = original;
      }
    });

    it('isDegraded() returns true when configured for local (persistent)', () => {
      const original = process.env.EMBEDDING_PROVIDER;
      process.env.EMBEDDING_PROVIDER = 'local';
      try {
        expect(embeddingsManager.isDegraded()).toBe(true);
      } finally {
        if (original === undefined) delete process.env.EMBEDDING_PROVIDER;
        else process.env.EMBEDDING_PROVIDER = original;
      }
    });

    it('does NOT mutate process.env.EMBEDDING_PROVIDER on remote failure (EMB-003)', async () => {
      vi.mocked(circuitBreaker.execute).mockRejectedValueOnce(new Error('network down'));
      vi.mocked(generateLocalEmbedding).mockReturnValue(new Array(3072).fill(0.1));
      vi.mocked(llmClientManager.hasClient).mockReturnValue(true);
      vi.mocked(llmClientManager.getClient).mockReturnValue({} as any);

      const original = process.env.EMBEDDING_PROVIDER;
      process.env.EMBEDDING_PROVIDER = 'auto';

      try {
        await embeddingsManager.generateEmbedding({ text: 'test' });
        // The critical assertion: process.env was NOT mutated to 'local'
        expect(process.env.EMBEDDING_PROVIDER).toBe('auto');
        // But the instance IS marked as transiently degraded
        expect(embeddingsManager.isDegraded()).toBe(true);
      } finally {
        if (original === undefined) delete process.env.EMBEDDING_PROVIDER;
        else process.env.EMBEDDING_PROVIDER = original;
      }
    });

    it('P1-03: resets transientDegradedToLocal when a subsequent remote call succeeds', async () => {
      // First call: remote fails -> degrade to local.
      vi.mocked(circuitBreaker.execute).mockRejectedValueOnce(new Error('network down'));
      vi.mocked(generateLocalEmbedding).mockReturnValue(new Array(3072).fill(0.1));
      vi.mocked(llmClientManager.hasClient).mockReturnValue(true);
      vi.mocked(llmClientManager.getClient).mockReturnValue({} as any);

      const original = process.env.EMBEDDING_PROVIDER;
      process.env.EMBEDDING_PROVIDER = 'auto';

      try {
        await embeddingsManager.generateEmbedding({ text: 'test' });
        expect(embeddingsManager.isDegraded()).toBe(true);

        // Second call: remote succeeds -> flag should reset.
        vi.mocked(circuitBreaker.execute).mockResolvedValueOnce({
          data: [{ index: 0, embedding: new Array(3072).fill(0.2) }],
          usage: { prompt_tokens: 10 },
        } as any);

        await embeddingsManager.generateEmbedding({ text: 'test' });
        // P1-03: The degraded flag should be reset to false after a
        // successful remote call. Without the reset, the system stays
        // degraded forever after a single failure.
        expect(embeddingsManager.isDegraded()).toBe(false);
      } finally {
        if (original === undefined) delete process.env.EMBEDDING_PROVIDER;
        else process.env.EMBEDDING_PROVIDER = original;
      }
    });

    it('normalizeEmbedding pads 1536d embeddings to 3072d (no silent cosine=0)', async () => {
      const shortEmbedding = new Array(1536).fill(0.5);
      vi.mocked(circuitBreaker.execute).mockResolvedValueOnce({
        data: [{ index: 0, embedding: shortEmbedding }],
        usage: { prompt_tokens: 10 },
      } as any);
      vi.mocked(llmClientManager.getClient).mockReturnValue({} as any);
      vi.mocked(llmClientManager.hasClient).mockReturnValue(true);

      const original = process.env.EMBEDDING_PROVIDER;
      process.env.EMBEDDING_PROVIDER = 'openrouter';
      try {
        const result = await embeddingsManager.generateEmbedding({ text: 'test' });
        expect(result).toHaveLength(3072);
      } finally {
        if (original === undefined) delete process.env.EMBEDDING_PROVIDER;
        else process.env.EMBEDDING_PROVIDER = original;
      }
    });

    it('normalizeEmbedding truncates >3072d embeddings to 3072d', async () => {
      const longEmbedding = new Array(4096).fill(0.3);
      vi.mocked(circuitBreaker.execute).mockResolvedValueOnce({
        data: [{ index: 0, embedding: longEmbedding }],
        usage: { prompt_tokens: 10 },
      } as any);
      vi.mocked(llmClientManager.getClient).mockReturnValue({} as any);
      vi.mocked(llmClientManager.hasClient).mockReturnValue(true);

      const original = process.env.EMBEDDING_PROVIDER;
      process.env.EMBEDDING_PROVIDER = 'openrouter';
      try {
        const result = await embeddingsManager.generateEmbedding({ text: 'test' });
        expect(result).toHaveLength(3072);
      } finally {
        if (original === undefined) delete process.env.EMBEDDING_PROVIDER;
        else process.env.EMBEDDING_PROVIDER = original;
      }
    });
  });
});
