import crypto from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================
// Mocks
// ============================================================

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../server/metrics/collector', () => ({
  metricsCollector: {
    recordCacheHit: vi.fn(),
    recordCacheMiss: vi.fn(),
  },
}));

vi.mock('../server/services/embedding-service', () => {
  const getEmbedding = vi.fn();
  const cosineSimilarity = vi.fn();
  return {
    embeddingService: {
      getEmbedding,
      cosineSimilarity,
    },
  };
});

// Mock cache-adapter to avoid actual Redis connections
vi.mock('../server/services/cache-adapter', () => {
  const store = new Map<string, { value: string; expiresAt: number }>();

  const mockCacheStore = {
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt > 0 && entry.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    }),
    set: vi.fn(async (key: string, value: string, ttlMs?: number) => {
      store.set(key, {
        value,
        expiresAt: ttlMs ? Date.now() + ttlMs : 0,
      });
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(async () => {
      store.clear();
    }),
    scan: vi.fn(async (pattern: string, limit = 100) => {
      const results: Array<{ key: string; value: string }> = [];
      const regex = new RegExp(
        '^' +
          pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') +
          '$',
      );
      const now = Date.now();
      for (const [key, entry] of store) {
        if (results.length >= limit) break;
        if (entry.expiresAt > 0 && entry.expiresAt <= now) {
          store.delete(key);
          continue;
        }
        if (regex.test(key)) {
          results.push({ key, value: entry.value });
        }
      }
      return results;
    }),
    isReady: vi.fn(() => true),
    getStats: vi.fn(() => ({
      type: 'redis' as const,
      ready: true,
      size: store.size,
      totalGets: 0,
      totalSets: 0,
      totalHits: 0,
      totalMisses: 0,
      hitRate: 0,
    })),
    destroy: vi.fn(async () => {
      store.clear();
    }),
    _store: store, // expose for test assertions
  };

  return {
    getCacheStore: vi.fn(async () => mockCacheStore),
    createCacheStore: vi.fn(async () => mockCacheStore),
    MemoryCacheStore: vi.fn(),
    RedisCacheStore: vi.fn(),
    resetCacheStore: vi.fn(),
    __mockStore: mockCacheStore,
  };
});

// ============================================================
// Imports (after mocks)
// ============================================================

import { AIResponseCache } from '../server/services/ai-cache';
import { canonicalizeQuery, SemanticCacheService } from '../server/services/semantic-cache';
import { embeddingService } from '../server/services/embedding-service';

// Access mock store for assertions
const cacheAdapterModule = await import('../server/services/cache-adapter');
const mockStore = (cacheAdapterModule as any).__mockStore;

// ============================================================
// Tests: AIResponseCache with distributed backing store
// ============================================================

describe('AIResponseCache — Distributed Backing Store', () => {
  let cache: AIResponseCache;

  beforeEach(async () => {
    cache = new AIResponseCache();
    mockStore._store.clear();
    vi.clearAllMocks();
    await cache.initBackingStore();
  });

  it('should initialise backing store', () => {
    const stats = cache.getStats();
    expect(stats.backingStore).toBe('memory+redis');
  });

  it('should write-through to distributed store on set', async () => {
    cache.set('test-key', 'test-value', 60000);
    // Allow fire-and-forget to complete
    await new Promise((r) => setTimeout(r, 10));
    expect(mockStore.set).toHaveBeenCalled();
    const call = mockStore.set.mock.calls[0];
    expect(call[0]).toBe('exact:test-key');
    expect(call[1]).toBe('test-value');
    expect(call[2]).toBe(60000);
  });

  it('should read from distributed store on getAsync cache miss', async () => {
    // Populate Redis directly (simulating another instance wrote it)
    mockStore._store.set('exact:remote-key', { value: 'remote-value', expiresAt: 0 });

    const result = await cache.getAsync('remote-key');
    expect(result).toBe('remote-value');
  });

  it('should prefer local in-memory over distributed store', async () => {
    cache.set('local-key', 'local-value');
    mockStore._store.set('exact:local-key', { value: 'remote-value', expiresAt: 0 });

    const result = await cache.getAsync('local-key');
    expect(result).toBe('local-value');
    // Should NOT have called backing store get (local hit short-circuited)
    const getCalls = mockStore.get.mock.calls.filter((c: any) => c[0] === 'exact:local-key');
    expect(getCalls.length).toBe(0);
  });

  it('should populate local cache after distributed store hit', async () => {
    mockStore._store.set('exact:fill-key', { value: 'fill-value', expiresAt: 0 });

    // First call: distributed hit
    await cache.getAsync('fill-key');

    // Second call: should be local hit (no additional Redis call)
    mockStore.get.mockClear();
    const local = cache.get('fill-key');
    expect(local).toBe('fill-value');
  });

  it('should clear distributed store on clear()', async () => {
    cache.set('k', 'v');
    await new Promise((r) => setTimeout(r, 10));
    cache.clear();
    await new Promise((r) => setTimeout(r, 10));
    expect(mockStore.clear).toHaveBeenCalled();
  });

  it('should report backingStore: memory when no Redis', () => {
    const memCache = new AIResponseCache();
    // Not calling initBackingStore — stays pure in-memory
    const stats = memCache.getStats();
    expect(stats.backingStore).toBe('memory');
  });

  it('should handle distributed store errors gracefully', async () => {
    mockStore.get.mockRejectedValueOnce(new Error('Redis down'));
    const result = await cache.getAsync('error-key');
    expect(result).toBeNull();
  });

  it('getAsync returns null when cache is disabled', async () => {
    const envCache = new (class extends AIResponseCache {
      constructor() {
        super();
        // @ts-ignore - access private for test
        (this as any).enabled = false;
      }
    })();
    const result = await envCache.getAsync('any-key');
    expect(result).toBeNull();
  });
});

// ============================================================
// Tests: SemanticCacheService with distributed backing store
// ============================================================

describe('SemanticCacheService — Distributed Backing Store', () => {
  let cache: SemanticCacheService;

  beforeEach(async () => {
    cache = new SemanticCacheService({ enabled: true });
    mockStore._store.clear();
    vi.clearAllMocks();
    await cache.initBackingStore();

    // Setup embedding mocks for semantic cache
    const getEmbedding = embeddingService.getEmbedding as ReturnType<typeof vi.fn>;
    getEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);

    const cosineSim = embeddingService.cosineSimilarity as ReturnType<typeof vi.fn>;
    cosineSim.mockReturnValue(0.95);
  });

  it('should report backingStore in stats', () => {
    const stats = cache.getStats();
    expect(stats.backingStore).toBe('memory+redis');
  });

  it('should write-through response to distributed store on set', async () => {
    await cache.set(
      'test query',
      'test response text here!!',
      'openai:gpt-4o',
      'chat',
      undefined,
      'fp-ctx',
    );
    // Allow fire-and-forget
    await new Promise((r) => setTimeout(r, 10));
    expect(mockStore.set).toHaveBeenCalled();
    const call = mockStore.set.mock.calls[0];
    expect(call[0]).toMatch(/^semantic:(.*:)?openai:gpt-4o:chat:fp-ctx:/);
    expect(call[1]).toBe('test response text here!!');
  });

  it('should persist full index entry (embedding + metadata) on set', async () => {
    await cache.set(
      'index query text',
      'response long enough for caching',
      'openai:gpt-4o',
      'chat',
      undefined,
      'fp-ctx',
    );
    await new Promise((r) => setTimeout(r, 10));

    // Should have two set calls: response + index entry
    const setCalls = mockStore.set.mock.calls;
    expect(setCalls.length).toBe(2);

    // Second call is the index entry
    const indexCall = setCalls[1];
    expect(indexCall[0]).toMatch(/^semantic-index:(.*:)?openai:gpt-4o:chat:fp-ctx:/);

    // Verify the index payload is valid JSON with embedding
    const payload = JSON.parse(indexCall[1]);
    expect(payload.queryEmbedding).toEqual([0.1, 0.2, 0.3]);
    expect(payload.queryText).toBe('index query text');
    expect(payload.response).toBe('response long enough for caching');
    expect(payload.model).toBe('openai:gpt-4o');
    expect(payload.operation).toBe('chat');
    expect(payload.contextFingerprint).toBe('fp-ctx');
    expect(payload.expiresAt).toBeGreaterThan(Date.now());
  });

  it('isolates Redis keys for the same query in different context fingerprints', async () => {
    await cache.set(
      'same user query',
      'response for context A long enough',
      'openai:gpt-4o',
      'chat',
      undefined,
      'fp-a',
    );
    await cache.set(
      'same user query',
      'response for context B long enough',
      'openai:gpt-4o',
      'chat',
      undefined,
      'fp-b',
    );
    await new Promise((r) => setTimeout(r, 10));

    const responseKeys = [...mockStore._store.keys()].filter(
      (key) => key.startsWith('semantic:') && key.includes('openai:gpt-4o:chat:'),
    );
    expect(responseKeys).toHaveLength(2);
    expect(responseKeys).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/openai:gpt-4o:chat:fp-a:/),
        expect.stringMatching(/openai:gpt-4o:chat:fp-b:/),
      ]),
    );
    const keyA = responseKeys.find((key) => key.includes(':fp-a:'));
    const keyB = responseKeys.find((key) => key.includes(':fp-b:'));
    expect(keyA).toBeDefined();
    expect(keyB).toBeDefined();
    expect(mockStore._store.get(keyA!)?.value).toBe('response for context A long enough');
    expect(mockStore._store.get(keyB!)?.value).toBe('response for context B long enough');
  });

  it('canonicalizes whitespace before hashing Redis keys', async () => {
    const rawQuery = '  Quais   são os riscos?\n';
    const expectedHash = crypto
      .createHash('sha256')
      .update(canonicalizeQuery(rawQuery))
      .digest('hex')
      .slice(0, 16);

    await cache.set(
      rawQuery,
      'response with enough content for semantic cache',
      'openai:gpt-4o',
      'chat',
      undefined,
      'fp-ws',
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(canonicalizeQuery(rawQuery)).toBe('Quais são os riscos?');
    expect(
      [...mockStore._store.keys()].some(
        (k) => k.startsWith('semantic:') && k.includes(`openai:gpt-4o:chat:fp-ws:${expectedHash}`),
      ),
    ).toBe(true);
    expect(
      [...mockStore._store.keys()].some(
        (k) =>
          k.startsWith('semantic-index:') && k.includes(`openai:gpt-4o:chat:fp-ws:${expectedHash}`),
      ),
    ).toBe(true);
  });

  it('should clear distributed store on clear()', async () => {
    await cache.set(
      'q',
      'response text that is long enough',
      'openai:gpt-4o',
      'chat',
      undefined,
      'fp-ctx',
    );
    await new Promise((r) => setTimeout(r, 10));
    cache.clear();
    await new Promise((r) => setTimeout(r, 10));
    expect(mockStore.clear).toHaveBeenCalled();
  });

  it('reports memory backingStore when initBackingStore not called', () => {
    const memOnly = new SemanticCacheService({ enabled: true });
    const stats = memOnly.getStats();
    expect(stats.backingStore).toBe('memory');
  });
});

// ============================================================
// Tests: Cold-start embedding index rebuild from Redis
// ============================================================

describe('SemanticCacheService — Cold Start Index Rebuild', () => {
  beforeEach(() => {
    mockStore._store.clear();
    vi.clearAllMocks();

    const getEmbedding = embeddingService.getEmbedding as ReturnType<typeof vi.fn>;
    getEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);

    const cosineSim = embeddingService.cosineSimilarity as ReturnType<typeof vi.fn>;
    cosineSim.mockReturnValue(0.95);
  });

  it('should rebuild embedding index from Redis on initBackingStore', async () => {
    // Pre-populate Redis with a serialised index entry (simulating previous run)
    const futureExpiry = Date.now() + 60 * 60 * 1000; // 1h from now
    const indexEntry = {
      queryEmbedding: [0.5, 0.6, 0.7],
      queryText: 'what is the weather',
      response: 'The weather is sunny and warm today.',
      model: 'openai:gpt-4o',
      operation: 'chat',
      embeddingModel: 'qwen/qwen3-embedding-8b',
      dimensions: 3072,
      createdAt: Date.now() - 5000,
      expiresAt: futureExpiry,
    };
    mockStore._store.set('semantic-index:openai:gpt-4o:chat:abc123', {
      value: JSON.stringify(indexEntry),
      expiresAt: 0,
    });

    // Create a fresh service and init backing store (cold start)
    const freshCache = new SemanticCacheService({ enabled: true });
    await freshCache.initBackingStore();

    // The index should now have 1 entry
    const stats = freshCache.getStats();
    expect(stats.size).toBe(1);
    expect(stats.backingStore).toBe('memory+redis');
  });

  it('should skip expired entries during rebuild', async () => {
    // Entry that already expired
    const expiredEntry = {
      queryEmbedding: [0.1, 0.2, 0.3],
      queryText: 'expired query',
      response: 'This response is stale and should not appear.',
      model: 'openai:gpt-4o',
      operation: 'chat',
      embeddingModel: 'qwen/qwen3-embedding-8b',
      dimensions: 3072,
      createdAt: Date.now() - 100000,
      expiresAt: Date.now() - 1000, // expired
    };
    mockStore._store.set('semantic-index:openai:gpt-4o:chat:expired', {
      value: JSON.stringify(expiredEntry),
      expiresAt: 0,
    });

    const freshCache = new SemanticCacheService({ enabled: true });
    await freshCache.initBackingStore();

    expect(freshCache.getStats().size).toBe(0);
  });

  it('should skip malformed entries during rebuild', async () => {
    mockStore._store.set('semantic-index:openai:gpt-4o:chat:bad', {
      value: 'not valid json {{{',
      expiresAt: 0,
    });

    const freshCache = new SemanticCacheService({ enabled: true });
    await freshCache.initBackingStore();

    expect(freshCache.getStats().size).toBe(0);
  });

  it('should skip entries with empty embeddings', async () => {
    const noEmbedding = {
      queryEmbedding: [],
      queryText: 'no embedding',
      response: 'This has no embedding vector.',
      model: 'openai:gpt-4o',
      operation: 'chat',
      embeddingModel: 'qwen/qwen3-embedding-8b',
      dimensions: 3072,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60000,
    };
    mockStore._store.set('semantic-index:openai:gpt-4o:chat:noemb', {
      value: JSON.stringify(noEmbedding),
      expiresAt: 0,
    });

    const freshCache = new SemanticCacheService({ enabled: true });
    await freshCache.initBackingStore();

    expect(freshCache.getStats().size).toBe(0);
  });

  it('should respect maxEntries during rebuild', async () => {
    // Create a service with maxEntries=2
    const smallCache = new SemanticCacheService({ enabled: true, maxEntries: 2 });

    // Put 5 index entries in Redis
    for (let i = 0; i < 5; i++) {
      const entry = {
        queryEmbedding: [i * 0.1, i * 0.2, i * 0.3],
        queryText: `query ${i}`,
        response: `response ${i} is long enough to be cached`,
        model: 'openai:gpt-4o',
        operation: 'chat',
        embeddingModel: 'qwen/qwen3-embedding-8b',
        dimensions: 3072,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000,
      };
      mockStore._store.set(`semantic-index:openai:gpt-4o:chat:q${i}`, {
        value: JSON.stringify(entry),
        expiresAt: 0,
      });
    }

    await smallCache.initBackingStore();

    expect(smallCache.getStats().size).toBe(2);
  });

  it('should allow similarity search on rebuilt entries', async () => {
    const futureExpiry = Date.now() + 60 * 60 * 1000;
    const indexEntry = {
      queryEmbedding: [0.5, 0.6, 0.7],
      queryText: 'original query from previous run',
      response: 'Cached response from previous instance.',
      model: 'openai:gpt-4o',
      operation: 'chat',
      embeddingModel: 'qwen/qwen3-embedding-8b',
      dimensions: 3072,
      // Spec 015 (H-04): entradas persistidas carregam o fingerprint; o hit
      // pós-rebuild exige o MESMO fingerprint contextual.
      contextFingerprint: 'fp-ctx',
      createdAt: Date.now() - 5000,
      expiresAt: futureExpiry,
    };
    mockStore._store.set('semantic-index:openai:gpt-4o:chat:prevrun', {
      value: JSON.stringify(indexEntry),
      expiresAt: 0,
    });

    const freshCache = new SemanticCacheService({ enabled: true });
    await freshCache.initBackingStore();

    // Now try a similarity lookup — cosine mock returns 0.95 > threshold 0.92
    const result = await freshCache.get('similar query', 'openai:gpt-4o', 'chat', 'fp-ctx');
    expect(result).not.toBeNull();
    expect(result!.response).toBe('Cached response from previous instance.');
    expect(result!.similarity).toBe(0.95);
    expect(result!.originalQuery).toBe('original query from previous run');
  });

  it('keeps rebuilt entries isolated by context fingerprint', async () => {
    const futureExpiry = Date.now() + 60 * 60 * 1000;
    const baseEntry = {
      queryEmbedding: [0.5, 0.6, 0.7],
      queryText: 'same persisted query',
      model: 'openai:gpt-4o',
      operation: 'chat',
      embeddingModel: 'qwen/qwen3-embedding-8b',
      dimensions: 3072,
      createdAt: Date.now() - 5000,
      expiresAt: futureExpiry,
    };

    mockStore._store.set('semantic-index:openai:gpt-4o:chat:fp-a:samehash', {
      value: JSON.stringify({
        ...baseEntry,
        response: 'rebuilt response for context A',
        contextFingerprint: 'fp-a',
      }),
      expiresAt: 0,
    });
    mockStore._store.set('semantic-index:openai:gpt-4o:chat:fp-b:samehash', {
      value: JSON.stringify({
        ...baseEntry,
        response: 'rebuilt response for context B',
        contextFingerprint: 'fp-b',
      }),
      expiresAt: 0,
    });

    const freshCache = new SemanticCacheService({ enabled: true });
    await freshCache.initBackingStore();

    const resultA = await freshCache.get('same persisted query', 'openai:gpt-4o', 'chat', 'fp-a');
    const resultB = await freshCache.get('same persisted query', 'openai:gpt-4o', 'chat', 'fp-b');

    expect(resultA?.response).toBe('rebuilt response for context A');
    expect(resultB?.response).toBe('rebuilt response for context B');
  });
});

// ============================================================
// Tests: cache-adapter factory
// ============================================================

describe('Cache Adapter — MemoryCacheStore', () => {
  it('should get/set/del with TTL', async () => {
    // Re-import real MemoryCacheStore (not mocked)
    const { MemoryCacheStore } = await vi.importActual<
      typeof import('../server/services/cache-adapter')
    >('../server/services/cache-adapter');

    const store = new MemoryCacheStore(10);
    await store.set('a', 'hello', 60000);
    expect(await store.get('a')).toBe('hello');

    await store.del('a');
    expect(await store.get('a')).toBeNull();
  });

  it('should expire entries after TTL', async () => {
    const { MemoryCacheStore } = await vi.importActual<
      typeof import('../server/services/cache-adapter')
    >('../server/services/cache-adapter');

    const store = new MemoryCacheStore(10);
    await store.set('b', 'world', 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 10));
    expect(await store.get('b')).toBeNull();
  });

  it('should evict oldest when over capacity', async () => {
    const { MemoryCacheStore } = await vi.importActual<
      typeof import('../server/services/cache-adapter')
    >('../server/services/cache-adapter');

    const store = new MemoryCacheStore(2);
    await store.set('x', '1');
    await store.set('y', '2');
    await store.set('z', '3'); // should evict 'x'
    expect(await store.get('x')).toBeNull();
    expect(await store.get('z')).toBe('3');
  });

  it('should report stats correctly', async () => {
    const { MemoryCacheStore } = await vi.importActual<
      typeof import('../server/services/cache-adapter')
    >('../server/services/cache-adapter');

    const store = new MemoryCacheStore(10);
    await store.set('k', 'v');
    await store.get('k'); // hit
    await store.get('miss'); // miss

    const stats = store.getStats();
    expect(stats.type).toBe('memory');
    expect(stats.ready).toBe(true);
    expect(stats.totalHits).toBe(1);
    expect(stats.totalMisses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(0.5);
  });

  it('should clear and reset stats', async () => {
    const { MemoryCacheStore } = await vi.importActual<
      typeof import('../server/services/cache-adapter')
    >('../server/services/cache-adapter');

    const store = new MemoryCacheStore(10);
    await store.set('k', 'v');
    await store.clear();

    const stats = store.getStats();
    expect(stats.size).toBe(0);
    expect(stats.totalGets).toBe(0);
  });

  it('should scan keys matching a glob pattern', async () => {
    const { MemoryCacheStore } = await vi.importActual<
      typeof import('../server/services/cache-adapter')
    >('../server/services/cache-adapter');

    const store = new MemoryCacheStore(100);
    await store.set('semantic-index:gpt:chat:a1', 'entry1');
    await store.set('semantic-index:gpt:chat:b2', 'entry2');
    await store.set('exact:somekey', 'other');
    await store.set('semantic-index:claude:chat:c3', 'entry3');

    const results = await store.scan('semantic-index:*');
    expect(results.length).toBe(3);
    expect(results.every((r) => r.key.startsWith('semantic-index:'))).toBe(true);
  });

  it('should respect scan limit', async () => {
    const { MemoryCacheStore } = await vi.importActual<
      typeof import('../server/services/cache-adapter')
    >('../server/services/cache-adapter');

    const store = new MemoryCacheStore(100);
    for (let i = 0; i < 10; i++) {
      await store.set(`prefix:item${i}`, `val${i}`);
    }

    const results = await store.scan('prefix:*', 3);
    expect(results.length).toBe(3);
  });
});
