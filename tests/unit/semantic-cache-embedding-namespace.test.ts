import { describe, it, expect, vi, beforeEach } from 'vitest';

const embeddingMock = vi.hoisted(() => ({
  getEmbedding: vi.fn(async () => [1, 0.5, 0.25]),
  cosineSimilarity: vi.fn(() => 0.99),
}));

vi.mock('../../server/services/embedding-service', () => ({
  embeddingService: embeddingMock,
}));

vi.mock('../../server/metrics/collector', () => ({
  metricsCollector: { recordCacheHit: vi.fn(), recordCacheMiss: vi.fn() },
}));

let activeModel = 'qwen/qwen3-embedding-8b';
const activeDimensions = 3072;

vi.mock('../../server/services/llm-embeddings-operations', () => ({
  embeddingsManager: {
    getEmbeddingModel: vi.fn(() => activeModel),
    getEmbeddingDimensions: vi.fn(() => activeDimensions),
  },
}));

import { SemanticCacheService } from '../../server/services/semantic-cache';

describe('SemanticCacheService embedding namespace (#10147)', () => {
  let cache: SemanticCacheService;

  beforeEach(() => {
    vi.clearAllMocks();
    cache = new SemanticCacheService({ enabled: true, similarityThreshold: 0.85 });
  });

  it('set stores entry with active embedding model and dimensions', async () => {
    await cache.set(
      'qual o prazo?',
      'resposta longa o suficiente para ser armazenada no cache',
      'or:m1',
      'chat',
      undefined,
      'fp-test',
    );

    const stats = cache.getStats();
    expect(stats.size).toBe(1);
  });

  it('rebuild skips entries from a different embedding model', async () => {
    const cacheAny = cache as unknown as {
      backingStore: {
        isReady: () => boolean;
        scan: (pattern: string, count: number) => Promise<{ value: string }[]>;
      };
      entries: unknown[];
      rebuildIndexFromStore: () => Promise<void>;
    };

    cacheAny.backingStore = {
      isReady: () => true,
      scan: async () => [
        {
          value: JSON.stringify({
            queryEmbedding: [1, 0.5, 0.25],
            queryText: 'old query',
            response: 'old response',
            model: 'or:m1',
            operation: 'chat',
            contextFingerprint: 'fp-old',
            embeddingModel: 'old/model',
            dimensions: activeDimensions,
            createdAt: Date.now(),
            expiresAt: Date.now() + 60000,
          }),
        },
      ],
    };

    await cacheAny.rebuildIndexFromStore();
    expect(cacheAny.entries.length).toBe(0);
  });

  it('rebuild loads entries matching active embedding model and dimensions', async () => {
    const cacheAny = cache as unknown as {
      backingStore: {
        isReady: () => boolean;
        scan: (pattern: string, count: number) => Promise<{ value: string }[]>;
      };
      entries: unknown[];
      rebuildIndexFromStore: () => Promise<void>;
    };

    cacheAny.backingStore = {
      isReady: () => true,
      scan: async () => [
        {
          value: JSON.stringify({
            queryEmbedding: [1, 0.5, 0.25],
            queryText: 'old query',
            response: 'old response',
            model: 'or:m1',
            operation: 'chat',
            contextFingerprint: 'fp-old',
            embeddingModel: activeModel,
            dimensions: activeDimensions,
            createdAt: Date.now(),
            expiresAt: Date.now() + 60000,
          }),
        },
      ],
    };

    await cacheAny.rebuildIndexFromStore();
    expect(cacheAny.entries.length).toBe(1);
  });

  it('get() ignores in-memory entries when embedding model changes at runtime', async () => {
    embeddingMock.getEmbedding.mockResolvedValue([1, 0.5, 0.25]);
    embeddingMock.cosineSimilarity.mockReturnValue(0.99);

    await cache.set(
      'query text',
      'long enough response to be cached',
      'or:m1',
      'chat',
      undefined,
      'fp-runtime',
    );
    expect((await cache.get('query text', 'or:m1', 'chat', 'fp-runtime'))?.response).toBe(
      'long enough response to be cached',
    );

    // Simulate runtime swap of embedding provider
    activeModel = 'other-embedding-model';
    const afterSwap = await cache.get('query text', 'or:m1', 'chat', 'fp-runtime');
    expect(afterSwap).toBeNull();
  });
});
