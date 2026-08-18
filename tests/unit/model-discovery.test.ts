import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@shared/schema';
import { ModelDiscovery, fetchOpenRouterCatalog } from '../../server/services/model-discovery';
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
  CREATE TABLE model_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias TEXT NOT NULL,
    family TEXT NOT NULL,
    provider TEXT NOT NULL,
    current_model_id TEXT NOT NULL,
    candidate_model_id TEXT NOT NULL,
    candidate_version TEXT,
    status TEXT NOT NULL DEFAULT 'discovered',
    selection_reason TEXT,
    evidence TEXT DEFAULT '{}',
    capabilities TEXT DEFAULT '{}',
    discovered_at INTEGER NOT NULL,
    validated_at INTEGER,
    validation_error TEXT
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

// Mock OpenRouter catalog response
const OPENROUTER_MOCK_RESPONSE = {
  data: [
    {
      id: 'deepseek/deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      context_length: 1048576,
      pricing: { prompt: '0.000000435', completion: '0.00000087' },
      architecture: {
        modality: 'text->text',
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
    },
    {
      id: 'deepseek/deepseek-v5-pro',
      name: 'DeepSeek V5 Pro',
      context_length: 1048576,
      pricing: { prompt: '0.0000005', completion: '0.000001' },
      architecture: {
        modality: 'text->text',
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
    },
    {
      id: 'deepseek/deepseek-v4-pro-preview',
      name: 'DeepSeek V4 Pro Preview',
      context_length: 1048576,
      architecture: {
        modality: 'text->text',
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
    },
    {
      id: 'z-ai/glm-5.2',
      name: 'GLM 5.2',
      context_length: 131072,
      architecture: {
        modality: 'text->text',
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
    },
    {
      id: 'z-ai/glm-6.0',
      name: 'GLM 6.0',
      context_length: 131072,
      architecture: {
        modality: 'text->text',
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
    },
    {
      id: 'z-ai/glm-5.2-flash',
      name: 'GLM 5.2 Flash',
      context_length: 131072,
      architecture: {
        modality: 'text->text',
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
    },
    {
      id: 'qwen/qwen3-coder-next',
      name: 'Qwen3 Coder Next',
      context_length: 131072,
      architecture: {
        modality: 'text->text',
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
    },
    {
      id: 'minimax/minimax-m4',
      name: 'MiniMax M4',
      context_length: 131072,
      architecture: {
        modality: 'text->text',
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
    },
  ],
};

describe('ModelDiscovery', () => {
  let sqlite: Database.Database | null = null;
  let discovery: ModelDiscovery | null = null;

  beforeEach(() => {
    clearModelFamiliesCache();
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    discovery = new ModelDiscovery(testDb.db);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
    discovery = null;
    vi.unstubAllGlobals();
  });

  function mockFetchOnce(response: unknown, ok = true, status = 200) {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok,
      status,
      json: async () => response,
    });
  }

  describe('fetchOpenRouterCatalog', () => {
    it('parses a valid OpenRouter catalog response', async () => {
      mockFetchOnce(OPENROUTER_MOCK_RESPONSE);
      const models = await fetchOpenRouterCatalog();
      expect(models.length).toBe(8);
      expect(models[0].id).toBe('deepseek/deepseek-v4-pro');
      expect(models[0].provider).toBe('openrouter');
      expect(models[0].contextLength).toBe(1048576);
      expect(models[0].inputModalities).toEqual(['text']);
      expect(models[0].pricing?.prompt).toBe(0.000000435);
    });

    it('throws on HTTP error', async () => {
      mockFetchOnce(null, false, 500);
      await expect(fetchOpenRouterCatalog()).rejects.toThrow('HTTP 500');
    });

    it('throws on invalid response shape', async () => {
      mockFetchOnce({ notData: true });
      await expect(fetchOpenRouterCatalog()).rejects.toThrow('invalid response shape');
    });

    it('handles empty data array', async () => {
      mockFetchOnce({ data: [] });
      const models = await fetchOpenRouterCatalog();
      expect(models).toEqual([]);
    });

    it('handles timeout via abort', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          }),
      );
      await expect(fetchOpenRouterCatalog()).rejects.toThrow();
    });
  });

  describe('runCycle', () => {
    it('registers a newer candidate for deepseek-v4-pro family', async () => {
      // Seed the alias first
      const db = (discovery as unknown as { database: DbClient }).database;
      (db as unknown as { insert: (t: unknown) => { values: (v: unknown) => void } })
        .insert(schema.modelAliases)
        .values({
          alias: 'deepseek-v4-pro-latest',
          family: 'deepseek-v4-pro',
          provider: 'openrouter',
          activeModelId: 'deepseek/deepseek-v4-pro',
          status: 'active',
          source: 'static-fallback',
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      // Mock OpenRouter catalog (deepseek-v5-pro is newer)
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => OPENROUTER_MOCK_RESPONSE,
      }));

      const result = await discovery!.runCycle();
      expect(result.totalCandidates).toBeGreaterThan(0);

      const candidates = await discovery!.listCandidates({ alias: 'deepseek-v4-pro-latest' });
      const v5Candidate = candidates.find((c) => c.candidateModelId === 'deepseek/deepseek-v5-pro');
      expect(v5Candidate).toBeDefined();
      expect(v5Candidate?.status).toBe('discovered');
    });

    it('excludes preview variants', async () => {
      const db = (discovery as unknown as { database: DbClient }).database;
      (db as unknown as { insert: (t: unknown) => { values: (v: unknown) => void } })
        .insert(schema.modelAliases)
        .values({
          alias: 'deepseek-v4-pro-latest',
          family: 'deepseek-v4-pro',
          provider: 'openrouter',
          activeModelId: 'deepseek/deepseek-v4-pro',
          status: 'active',
          source: 'static-fallback',
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => OPENROUTER_MOCK_RESPONSE,
      }));

      await discovery!.runCycle();
      const candidates = await discovery!.listCandidates({ alias: 'deepseek-v4-pro-latest' });
      const previewCandidate = candidates.find((c) => c.candidateModelId.includes('preview'));
      expect(previewCandidate).toBeUndefined();
    });

    it('does not allow glm-flash to replace glm-latest (different family)', async () => {
      const db = (discovery as unknown as { database: DbClient }).database;
      (db as unknown as { insert: (t: unknown) => { values: (v: unknown) => void } })
        .insert(schema.modelAliases)
        .values({
          alias: 'glm-latest',
          family: 'glm',
          provider: 'openrouter',
          activeModelId: 'z-ai/glm-5.2',
          status: 'active',
          source: 'static-fallback',
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => OPENROUTER_MOCK_RESPONSE,
      }));

      await discovery!.runCycle();
      const candidates = await discovery!.listCandidates({ alias: 'glm-latest' });
      // glm-6.0 is a valid candidate (newer glm, no flash)
      const glm6 = candidates.find((c) => c.candidateModelId === 'z-ai/glm-6.0');
      expect(glm6).toBeDefined();
      // glm-5.2-flash must NOT be a candidate for glm-latest family
      const flash = candidates.find((c) => c.candidateModelId === 'z-ai/glm-5.2-flash');
      expect(flash).toBeUndefined();
    });

    it('handles fetch failure gracefully', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Network error'),
      );
      // Subsequent calls (for other providers) also fail
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

      const result = await discovery!.runCycle();
      expect(result.results.length).toBeGreaterThan(0);
      // At least one provider should have an error
      // Mistral/Xiaomi return empty (no key), OpenRouter fails
      expect(result.results.some((r) => r.fetched === false || r.error)).toBe(true);
    });

    it('does not register duplicate candidates', async () => {
      const db = (discovery as unknown as { database: DbClient }).database;
      (db as unknown as { insert: (t: unknown) => { values: (v: unknown) => void } })
        .insert(schema.modelAliases)
        .values({
          alias: 'deepseek-v4-pro-latest',
          family: 'deepseek-v4-pro',
          provider: 'openrouter',
          activeModelId: 'deepseek/deepseek-v4-pro',
          status: 'active',
          source: 'static-fallback',
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => OPENROUTER_MOCK_RESPONSE,
      }));

      await discovery!.runCycle();
      const firstCount = (await discovery!.listCandidates({ alias: 'deepseek-v4-pro-latest' }))
        .length;

      await discovery!.runCycle();
      const secondCount = (await discovery!.listCandidates({ alias: 'deepseek-v4-pro-latest' }))
        .length;

      expect(secondCount).toBe(firstCount);
    });
  });

  describe('Mistral catalog (mocked)', () => {
    it('skips when MISTRAL_API_KEY is not set', async () => {
      const originalKey = process.env.MISTRAL_API_KEY;
      delete process.env.MISTRAL_API_KEY;
      const { fetchMistralCatalog } = await import('../../server/services/model-discovery');
      const models = await fetchMistralCatalog();
      expect(models).toEqual([]);
      if (originalKey) process.env.MISTRAL_API_KEY = originalKey;
    });

    it('parses a valid Mistral catalog response', async () => {
      process.env.MISTRAL_API_KEY = 'test-key';
      const { fetchMistralCatalog } = await import('../../server/services/model-discovery');
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: 'mistral-medium-3.5',
              name: 'Mistral Medium 3.5',
              created: 1715000000,
              context_length: 32000,
            },
            {
              id: 'mistral-medium-4.0',
              name: 'Mistral Medium 4.0',
              created: 1716000000,
              context_length: 64000,
            },
          ],
        }),
      });
      const models = await fetchMistralCatalog();
      expect(models.length).toBe(2);
      expect(models[0].id).toBe('mistral-medium-3.5');
      expect(models[0].provider).toBe('mistral');
      expect(models[0].createdAt).toBeInstanceOf(Date);
      delete process.env.MISTRAL_API_KEY;
    });

    it('handles authentication failure', async () => {
      process.env.MISTRAL_API_KEY = 'bad-key';
      const { fetchMistralCatalog } = await import('../../server/services/model-discovery');
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'unauthorized' }),
      });
      await expect(fetchMistralCatalog()).rejects.toThrow('authentication failed');
      delete process.env.MISTRAL_API_KEY;
    });
  });

  describe('Xiaomi catalog (mocked)', () => {
    it('skips when XIAOMI_API_KEY is not set', async () => {
      const originalKey = process.env.XIAOMI_API_KEY;
      delete process.env.XIAOMI_API_KEY;
      const { fetchXiaomiCatalog } = await import('../../server/services/model-discovery');
      const models = await fetchXiaomiCatalog();
      expect(models).toEqual([]);
      if (originalKey) process.env.XIAOMI_API_KEY = originalKey;
    });

    it('handles unrecognized response shape gracefully', async () => {
      process.env.XIAOMI_API_KEY = 'test-key';
      const { fetchXiaomiCatalog } = await import('../../server/services/model-discovery');
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ unexpected: true }),
      });
      const models = await fetchXiaomiCatalog();
      expect(models).toEqual([]);
      delete process.env.XIAOMI_API_KEY;
    });

    it('parses array response shape', async () => {
      process.env.XIAOMI_API_KEY = 'test-key';
      const { fetchXiaomiCatalog } = await import('../../server/services/model-discovery');
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', context_length: 131072 },
          { id: 'mimo-v3.0-pro', name: 'MiMo V3.0 Pro', context_length: 131072 },
        ],
      });
      const models = await fetchXiaomiCatalog();
      expect(models.length).toBe(2);
      expect(models[0].id).toBe('mimo-v2.5-pro');
      expect(models[0].provider).toBe('xiaomi');
      delete process.env.XIAOMI_API_KEY;
    });
  });
});
