import crypto from 'crypto';
import { env } from '../config/env';
import { metricsCollector } from '../metrics/collector';
import { ICacheStore, getCacheStore } from './cache-adapter';
import { logger } from '../utils/logger';

export const DEFAULT_CACHE_KEY_VERSION = 'cache-canonical-v2';

// Cache key version for invalidation when normalization changes (read dynamically for testing)
// H-12: bumped to v2 — cache keys now include agentName and demandId to prevent
// cross-agent/cross-demand cache contamination. Old v1 entries will miss.
const getCacheKeyVersion = (): string => process.env.CACHE_KEY_VERSION || DEFAULT_CACHE_KEY_VERSION;

interface CacheEntry {
  value: string;
  createdAt: number;
  expiresAt: number;
  hits: number;
}

export interface AICacheStats {
  enabled: boolean;
  size: number;
  maxEntries: number;
  ttlMs: number;
  totalHits: number;
  totalMisses: number;
  hitRate: number;
  backingStore: 'memory' | 'redis' | 'memory+redis';
  // Diagnostic fields for stability analysis
  totalEvictedByTTL: number;
  totalEvictedByLRU: number;
  avgEntryAgeMs: number;
  oldestEntryAgeMs: number;
  newestEntryAgeMs: number;
}

const stableStringify = (value: unknown): string => {
  // CRIT-8: `JSON.stringify(undefined)` retorna o valor `undefined` (não uma
  // string) — interpolado num template literal, isso virava a string literal
  // "undefined". Um payload com `{maxTokens: undefined}` produzia
  // `"maxTokens":undefined` na chave estável; uma chamada equivalente que
  // simplesmente OMITE `maxTokens` (chave ausente) produzia uma string
  // diferente, gerando hashes diferentes para o mesmo cache key lógico
  // (cache miss silencioso). Normalizamos `undefined` para `null`, igual ao
  // comportamento do `JSON.stringify` nativo dentro de arrays/objetos.
  if (value === undefined) {
    return 'null';
  }

  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  return `{${Object.keys(value as Record<string, unknown>)
    // Chaves com valor `undefined` são omitidas — mesma semântica do
    // `JSON.stringify` nativo para objetos, e o que garante que
    // `{a: 1, b: undefined}` e `{a: 1}` produzam a mesma chave de cache.
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
};

export class AIResponseCache {
  private readonly entries = new Map<string, CacheEntry>();
  // Spec 10125 #14: centralize cache configuration in env.ts.
  private readonly enabled = process.env.AI_RESPONSE_CACHE_ENABLED !== 'false';
  private readonly maxEntries = env.aiResponseCacheMaxEntries;
  private readonly ttlMs = env.aiResponseCacheTtlMs;
  private totalMisses = 0;
  private totalEvictedByTTL = 0;
  private totalEvictedByLRU = 0;

  /**
   * Optional distributed backing store (Redis).
   * When set, get/set/clear also go through Redis so data survives
   * restarts and is shared across instances.
   */
  private backingStore: ICacheStore | null = null;
  private backingStoreType: 'memory' | 'redis' = 'memory';

  constructor() {
    logger.info('AIResponseCache initialized', {
      context: {
        maxEntries: this.maxEntries,
        ttlMs: this.ttlMs,
        enabled: this.enabled,
      },
    });
  }

  /**
   * Initialise the distributed backing store (Redis when REDIS_URL is set).
   * Safe to call multiple times — only initialises once.
   */
  async initBackingStore(): Promise<void> {
    if (this.backingStore) return;
    try {
      const store = await getCacheStore();
      this.backingStore = store;
      this.backingStoreType = store.getStats().type;
      if (this.backingStoreType === 'redis') {
        logger.info('AIResponseCache: Redis backing store enabled');
      }
    } catch (_) {
      // fallback: pure in-memory
    }
  }

  createKey(payload: Record<string, unknown>): string {
    // Include cache key version in the hash for invalidation
    const payloadWithVersion = {
      ...payload,
      cacheKeyVersion: getCacheKeyVersion(),
    };
    const hash = crypto.createHash('sha256');
    hash.update(stableStringify(payloadWithVersion));
    return hash.digest('hex');
  }

  /**
   * Synchronous get from local in-memory store.
   * For distributed reads, use `getAsync` which also checks Redis.
   */
  get(key: string): string | null {
    if (!this.enabled) {
      return null;
    }

    const entry = this.entries.get(key);
    if (!entry) {
      // Cache miss - registrar métrica
      this.totalMisses += 1;
      metricsCollector.recordCacheMiss();
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      // Expired entry counts as miss
      this.totalMisses += 1;
      metricsCollector.recordCacheMiss();
      return null;
    }

    entry.hits += 1;
    this.entries.delete(key);
    this.entries.set(key, entry);

    // Cache hit - registrar métrica
    metricsCollector.recordCacheHit();

    return entry.value;
  }

  /**
   * Async get: checks local memory first, then distributed store (Redis).
   * This is the preferred method in async contexts (e.g. LLM call path).
   */
  async getAsync(key: string): Promise<string | null> {
    if (!this.enabled) return null;

    // 1. Local in-memory (fast path)
    const local = this.get(key);
    if (local !== null) return local;

    // 2. Distributed store (Redis)
    if (this.backingStore && this.backingStore.isReady()) {
      try {
        const remote = await this.backingStore.get(`exact:${key}`);
        if (remote !== null) {
          // Populate local cache for subsequent sync reads
          const now = Date.now();
          this.entries.set(key, {
            value: remote,
            createdAt: now,
            expiresAt: now + this.ttlMs,
            hits: 1,
          });
          this.prune();
          // Undo the miss counter that get() just incremented
          this.totalMisses = Math.max(0, this.totalMisses - 1);
          metricsCollector.recordCacheHit();
          return remote;
        }
      } catch (_) {
        // Redis error — already counted as miss from get() above
      }
    }

    return null;
  }

  set(key: string, value: string, ttlMs = this.ttlMs): void {
    if (!this.enabled || !value.trim()) {
      return;
    }

    this.entries.set(key, {
      value,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      hits: 0,
    });

    this.prune();

    // Write-through to distributed store (fire-and-forget)
    if (this.backingStore && this.backingStore.isReady()) {
      this.backingStore.set(`exact:${key}`, value, ttlMs).catch(() => {
        /* non-fatal */
      });
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalMisses = 0; // Reset miss counter

    // Also clear distributed store
    if (this.backingStore && this.backingStore.isReady()) {
      this.backingStore.clear().catch(() => {
        /* non-fatal */
      });
    }
  }

  getStats(): AICacheStats {
    this.pruneExpired();

    let totalHits = 0;
    const now = Date.now();
    let oldestAge = 0;
    let newestAge = Infinity;
    let totalAge = 0;

    for (const entry of Array.from(this.entries.values())) {
      totalHits += entry.hits;
      const age = now - entry.createdAt;
      totalAge += age;
      if (age > oldestAge) oldestAge = age;
      if (age < newestAge) newestAge = age;
    }

    const totalRequests = totalHits + this.totalMisses;
    const hitRate = totalRequests > 0 ? totalHits / totalRequests : 0;
    const avgEntryAgeMs = this.entries.size > 0 ? Math.round(totalAge / this.entries.size) : 0;

    const storeType = this.backingStoreType;
    const backingStore: AICacheStats['backingStore'] =
      storeType === 'redis' ? 'memory+redis' : 'memory';

    return {
      enabled: this.enabled,
      size: this.entries.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      totalHits,
      totalMisses: this.totalMisses,
      hitRate,
      backingStore,
      totalEvictedByTTL: this.totalEvictedByTTL,
      totalEvictedByLRU: this.totalEvictedByLRU,
      avgEntryAgeMs,
      oldestEntryAgeMs: this.entries.size > 0 ? Math.round(oldestAge) : 0,
      newestEntryAgeMs: this.entries.size > 0 ? Math.round(newestAge) : 0,
    };
  }

  private prune(): void {
    this.pruneExpired();

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) {
        return;
      }
      this.entries.delete(oldestKey);
      this.totalEvictedByLRU++;
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of Array.from(this.entries.entries())) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        this.totalEvictedByTTL++;
      }
    }
  }

  /**
   * Reset eviction counters (for tests/monitoring).
   */
  resetEvictionCounters(): void {
    this.totalEvictedByTTL = 0;
    this.totalEvictedByLRU = 0;
  }
}

export const aiResponseCache = new AIResponseCache();
