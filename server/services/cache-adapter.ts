/**
 * Cache Adapter — Redis with In-Memory Fallback
 *
 * Provides a unified cache interface that can use either Redis (for
 * persistence across restarts) or in-memory storage (zero dependencies).
 *
 * Architecture:
 * - Interface: ICacheStore with get/set/del/clear/getStats
 * - Implementations: RedisCacheStore + MemoryCacheStore
 * - Factory: createCacheStore() picks Redis if REDIS_URL is set, else memory
 * - Graceful degradation: if Redis connection fails, falls back to memory
 *
 * Env vars:
 * - REDIS_URL            (e.g., redis://localhost:6379)
 * - REDIS_KEY_PREFIX     (default: aichatflow:)
 * - REDIS_CONNECT_TIMEOUT_MS (default: 3000)
 *
 * This module does NOT import ioredis at the module level — it uses
 * dynamic import so the dependency is only needed when Redis is configured.
 */

import { logger } from '../utils/logger';

// ============================================
// Interface
// ============================================

export interface ICacheStore {
  /** Get a value by key. Returns null if not found or expired. */
  get(key: string): Promise<string | null>;
  /** Set a value with optional TTL in milliseconds. */
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  /** Delete a key. */
  del(key: string): Promise<void>;
  /** Clear all keys (with optional prefix filter for Redis). */
  clear(): Promise<void>;
  /** Scan keys matching a glob pattern. Returns key-value pairs. */
  scan(pattern: string, limit?: number): Promise<Array<{ key: string; value: string }>>;
  /** Check if the store is connected/ready. */
  isReady(): boolean;
  /** Get store statistics. */
  getStats(): CacheStoreStats;
  /** Graceful shutdown. */
  destroy(): Promise<void>;
}

export interface CacheStoreStats {
  type: 'memory' | 'redis';
  ready: boolean;
  size: number;
  totalGets: number;
  totalSets: number;
  totalHits: number;
  totalMisses: number;
  hitRate: number;
}

// ============================================
// In-Memory Implementation
// ============================================

interface MemoryEntry {
  value: string;
  expiresAt: number; // 0 = no expiry
}

export class MemoryCacheStore implements ICacheStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly maxEntries: number;
  private totalGets = 0;
  private totalSets = 0;
  private totalHits = 0;
  private totalMisses = 0;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  async get(key: string): Promise<string | null> {
    this.totalGets++;
    const entry = this.entries.get(key);
    if (!entry) {
      this.totalMisses++;
      return null;
    }
    if (entry.expiresAt > 0 && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      this.totalMisses++;
      return null;
    }
    this.totalHits++;
    return entry.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.totalSets++;
    this.entries.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : 0,
    });
    this.prune();
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async clear(): Promise<void> {
    this.entries.clear();
    this.totalGets = 0;
    this.totalSets = 0;
    this.totalHits = 0;
    this.totalMisses = 0;
  }

  async scan(pattern: string, limit = 100): Promise<Array<{ key: string; value: string }>> {
    const now = Date.now();
    const results: Array<{ key: string; value: string }> = [];
    // Convert glob pattern to regex (support * and ?)
    const regex = new RegExp(
      '^' +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') +
        '$',
    );
    for (const [key, entry] of this.entries) {
      if (results.length >= limit) break;
      if (entry.expiresAt > 0 && entry.expiresAt <= now) {
        this.entries.delete(key);
        continue;
      }
      if (regex.test(key)) {
        results.push({ key, value: entry.value });
      }
    }
    return results;
  }

  isReady(): boolean {
    return true;
  }

  getStats(): CacheStoreStats {
    // Prune expired before counting
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > 0 && entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
    const totalRequests = this.totalHits + this.totalMisses;
    return {
      type: 'memory',
      ready: true,
      size: this.entries.size,
      totalGets: this.totalGets,
      totalSets: this.totalSets,
      totalHits: this.totalHits,
      totalMisses: this.totalMisses,
      hitRate: totalRequests > 0 ? this.totalHits / totalRequests : 0,
    };
  }

  async destroy(): Promise<void> {
    this.entries.clear();
  }

  private prune(): void {
    // Evict expired
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > 0 && entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
    // Evict oldest if over capacity
    while (this.entries.size > this.maxEntries) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey) this.entries.delete(firstKey);
    }
  }
}

// ============================================
// Redis Implementation
// ============================================

interface RedisClient {
  connect(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, duration?: number): Promise<'OK' | null>;
  del(...keys: string[]): Promise<number>;
  scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
  quit(): Promise<'OK'>;
  disconnect(): Promise<void>;
  on(event: string, handler: () => void): void;
}

export class RedisCacheStore implements ICacheStore {
  private client: RedisClient | null = null; // ioredis client (dynamic import)
  private readonly redisUrl: string;
  private readonly keyPrefix: string;
  private ready = false;
  private totalGets = 0;
  private totalSets = 0;
  private totalHits = 0;
  private totalMisses = 0;
  private fallback: MemoryCacheStore;

  constructor(
    redisUrl: string,
    keyPrefix = 'aichatflow:',
    private readonly connectTimeoutMs = 3000,
  ) {
    this.redisUrl = redisUrl;
    this.keyPrefix = keyPrefix;
    this.fallback = new MemoryCacheStore();
  }

  async connect(): Promise<boolean> {
    try {
      // Dynamic import — ioredis only needed when Redis is configured
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { default: Redis } = await (Function('return import("ioredis")')() as Promise<any>);
      this.client = new Redis(this.redisUrl, {
        connectTimeout: this.connectTimeoutMs,
        maxRetriesPerRequest: 1,
        retryStrategy: (times: number) => {
          if (times > 3) return null; // Stop retrying
          return Math.min(times * 200, 1000);
        },
        lazyConnect: true,
      });

      await this.client!.connect();
      this.ready = true;
      logger.info('Redis cache connected', {
        context: { url: this.redisUrl.replace(/\/\/.*@/, '//***@') }, // Mask credentials
      });
      return true;
    } catch (error) {
      logger.warn('Redis connection failed, using in-memory fallback', {
        context: { error: error instanceof Error ? error.message : String(error) },
      });
      this.ready = false;
      return false;
    }
  }

  async get(key: string): Promise<string | null> {
    this.totalGets++;
    if (!this.ready || !this.client) {
      return this.fallback.get(key);
    }

    try {
      const value = await this.client.get(`${this.keyPrefix}${key}`);
      if (value !== null) {
        this.totalHits++;
      } else {
        this.totalMisses++;
      }
      return value;
    } catch (_) {
      this.totalMisses++;
      return this.fallback.get(key);
    }
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.totalSets++;
    if (!this.ready || !this.client) {
      return this.fallback.set(key, value, ttlMs);
    }

    try {
      const fullKey = `${this.keyPrefix}${key}`;
      if (ttlMs) {
        await this.client.set(fullKey, value, 'PX', ttlMs);
      } else {
        await this.client.set(fullKey, value);
      }
    } catch (_) {
      return this.fallback.set(key, value, ttlMs);
    }
  }

  async del(key: string): Promise<void> {
    if (!this.ready || !this.client) {
      return this.fallback.del(key);
    }
    try {
      await this.client.del(`${this.keyPrefix}${key}`);
    } catch (_) {
      return this.fallback.del(key);
    }
  }

  async scan(pattern: string, limit = 100): Promise<Array<{ key: string; value: string }>> {
    if (!this.ready || !this.client) {
      return this.fallback.scan(pattern, limit);
    }

    try {
      const results: Array<{ key: string; value: string }> = [];
      let cursor = '0';
      const fullPattern = `${this.keyPrefix}${pattern}`;

      do {
        const [nextCursor, keys] = await this.client.scan(
          cursor,
          'MATCH',
          fullPattern,
          'COUNT',
          Math.min(limit * 2, 200),
        );
        cursor = nextCursor;

        for (const key of keys) {
          if (results.length >= limit) break;
          const value = await this.client.get(key);
          if (value !== null) {
            // Strip prefix from key for consumer
            const strippedKey = key.startsWith(this.keyPrefix)
              ? key.slice(this.keyPrefix.length)
              : key;
            results.push({ key: strippedKey, value });
          }
        }
      } while (cursor !== '0' && results.length < limit);

      return results;
    } catch (_) {
      return this.fallback.scan(pattern, limit);
    }
  }

  async clear(): Promise<void> {
    this.totalGets = 0;
    this.totalSets = 0;
    this.totalHits = 0;
    this.totalMisses = 0;

    if (!this.ready || !this.client) {
      return this.fallback.clear();
    }

    try {
      // Use SCAN to find and delete all keys with our prefix
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.client.scan(
          cursor,
          'MATCH',
          `${this.keyPrefix}*`,
          'COUNT',
          100,
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          await this.client.del(...keys);
        }
      } while (cursor !== '0');
    } catch (_) {
      return this.fallback.clear();
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  getStats(): CacheStoreStats {
    const totalRequests = this.totalHits + this.totalMisses;
    return {
      type: 'redis',
      ready: this.ready,
      size: -1, // Redis DBSIZE is expensive; skip
      totalGets: this.totalGets,
      totalSets: this.totalSets,
      totalHits: this.totalHits,
      totalMisses: this.totalMisses,
      hitRate: totalRequests > 0 ? this.totalHits / totalRequests : 0,
    };
  }

  async destroy(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch (_) {
        /* ignore */
      }
      this.client = null;
    }
    this.ready = false;
    await this.fallback.destroy();
  }
}

// ============================================
// Factory
// ============================================

/**
 * Create a cache store instance. Uses Redis if REDIS_URL is set,
 * otherwise falls back to in-memory.
 */
export async function createCacheStore(maxMemoryEntries = 500): Promise<ICacheStore> {
  const redisUrl = process.env.REDIS_URL;
  const keyPrefix = process.env.REDIS_KEY_PREFIX || 'aichatflow:';
  const connectTimeout = parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS || '', 10) || 3000;

  if (redisUrl) {
    const store = new RedisCacheStore(redisUrl, keyPrefix, connectTimeout);
    const connected = await store.connect();
    if (connected) return store;
    // Connection failed; factory returns memory fallback
    logger.warn('Redis unavailable, using in-memory cache');
  }

  return new MemoryCacheStore(maxMemoryEntries);
}

/** Singleton instance — initialized lazily. */
let _cacheStore: ICacheStore | null = null;

export async function getCacheStore(): Promise<ICacheStore> {
  if (!_cacheStore) {
    _cacheStore = await createCacheStore();
  }
  return _cacheStore;
}

/** For tests: reset the singleton. */
export function resetCacheStore(): void {
  _cacheStore = null;
}
