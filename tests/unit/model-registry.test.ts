import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@shared/schema';
import { ModelRegistry } from '../../server/services/model-registry';
import { UnknownModelAliasError } from '../../server/services/model-registry-errors';
import { clearModelFamiliesCache } from '../../server/services/model-family-rules';
import type { DbClient } from '../../server/db';

const SCHEMA_SQL = `
  CREATE TABLE model_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias TEXT NOT NULL UNIQUE,
    family TEXT NOT NULL,
    provider TEXT NOT NULL,
    active_model_id TEXT NOT NULL,
    fallback_model_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    source TEXT NOT NULL DEFAULT 'static-fallback',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_validated_at INTEGER,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_failure_at INTEGER,
    last_rollback_at INTEGER
  );
  CREATE TABLE model_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias TEXT NOT NULL,
    previous_model_id TEXT,
    new_model_id TEXT,
    action TEXT NOT NULL,
    reason TEXT,
    triggered_by TEXT NOT NULL DEFAULT 'system',
    created_at INTEGER NOT NULL,
    metadata TEXT DEFAULT '{}'
  );
`;

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(SCHEMA_SQL);
  const db = drizzle(sqlite, { schema }) as unknown as DbClient;
  return { sqlite, db };
}

describe('ModelRegistry', () => {
  let sqlite: Database.Database | null = null;
  let registry: ModelRegistry | null = null;

  beforeEach(() => {
    clearModelFamiliesCache();
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    registry = new ModelRegistry(testDb.db);
  });

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
    registry = null;
  });

  describe('resolve', () => {
    it('resolves a known alias from static fallback', async () => {
      const resolved = await registry!.resolve('mimo-pro-latest');
      expect(resolved.alias).toBe('mimo-pro-latest');
      expect(resolved.modelId).toBe('mimo-v2.5-pro');
      expect(resolved.provider).toBe('xiaomi');
      expect(resolved.source).toBe('static-fallback');
      expect(resolved.fallbackId).toBe('deepseek/deepseek-v4-pro');
    });

    it('resolves a concrete model id to its family', async () => {
      const resolved = await registry!.resolve('mimo-v2.5-pro');
      expect(resolved.modelId).toBe('mimo-v2.5-pro');
      expect(resolved.provider).toBe('xiaomi');
      expect(resolved.alias).toBe('mimo-pro-latest');
    });

    it('resolves codestral-latest (native alias)', async () => {
      const resolved = await registry!.resolve('codestral-latest');
      expect(resolved.modelId).toBe('codestral-latest');
      expect(resolved.provider).toBe('mistral');
    });

    it('resolves qwen-coder-latest to qwen3-coder-next', async () => {
      const resolved = await registry!.resolve('qwen-coder-latest');
      expect(resolved.modelId).toBe('qwen/qwen3-coder-next');
      expect(resolved.provider).toBe('openrouter');
    });

    it('resolves glm-latest to glm-5.2', async () => {
      const resolved = await registry!.resolve('glm-latest');
      expect(resolved.modelId).toBe('glm-5.2');
      expect(resolved.provider).toBe('tencent');
    });

    it('resolves deepseek-v4-pro-latest', async () => {
      const resolved = await registry!.resolve('deepseek-v4-pro-latest');
      expect(resolved.modelId).toBe('deepseek/deepseek-v4-pro');
    });

    it('throws UnknownModelAliasError for unknown alias', async () => {
      await expect(registry!.resolve('nonexistent-alias')).rejects.toThrow(UnknownModelAliasError);
    });

    it('throws for empty input', async () => {
      await expect(registry!.resolve('')).rejects.toThrow(UnknownModelAliasError);
    });

    it('uses memory cache on second call', async () => {
      const first = await registry!.resolve('mimo-pro-latest');
      const second = await registry!.resolve('mimo-pro-latest');
      expect(second.modelId).toBe(first.modelId);
      expect(second.source).toBe('memory-cache');
    });

    it('resolves from database after seeding', async () => {
      await registry!.seedIfNeeded();
      registry!.reset(); // clear memory cache
      const resolved = await registry!.resolve('mimo-pro-latest');
      expect(resolved.source).toBe('database');
      expect(resolved.modelId).toBe('mimo-v2.5-pro');
    });
  });

  describe('listAliases', () => {
    it('returns all configured aliases from static fallback', async () => {
      const aliases = await registry!.listAliases();
      expect(aliases.length).toBeGreaterThanOrEqual(11);
      const mimo = aliases.find((a) => a.alias === 'mimo-pro-latest');
      expect(mimo).toBeDefined();
      expect(mimo?.provider).toBe('xiaomi');
      expect(mimo?.source).toBe('static-fallback');
    });

    it('returns database source after seeding', async () => {
      await registry!.seedIfNeeded();
      const aliases = await registry!.listAliases();
      const mimo = aliases.find((a) => a.alias === 'mimo-pro-latest');
      expect(mimo?.source).toBe('database');
    });
  });

  describe('invalidate', () => {
    it('invalidates a single alias', async () => {
      await registry!.resolve('mimo-pro-latest');
      await registry!.invalidate('mimo-pro-latest');
      const resolved = await registry!.resolve('mimo-pro-latest');
      expect(resolved.source).not.toBe('memory-cache');
    });

    it('invalidates the entire cache', async () => {
      await registry!.resolve('mimo-pro-latest');
      await registry!.resolve('codestral-latest');
      await registry!.invalidate();
      const resolved = await registry!.resolve('mimo-pro-latest');
      expect(resolved.source).not.toBe('memory-cache');
    });
  });

  describe('seedIfNeeded', () => {
    it('is idempotent', async () => {
      await registry!.seedIfNeeded();
      await registry!.seedIfNeeded(); // should not throw
      const aliases = await registry!.listAliases();
      const mimoCount = aliases.filter((a) => a.alias === 'mimo-pro-latest').length;
      expect(mimoCount).toBe(1);
    });

    it('creates history entries for seeded aliases', async () => {
      await registry!.seedIfNeeded();
      const db = (registry as unknown as { database: BetterSQLite3Database<typeof schema> })
        .database;
      const history = db.select().from(schema.modelHistory).all();
      expect(history.length).toBeGreaterThanOrEqual(11);
      const seeded = history.filter((h) => h.action === 'seeded');
      expect(seeded.length).toBeGreaterThanOrEqual(11);
    });
  });
});
