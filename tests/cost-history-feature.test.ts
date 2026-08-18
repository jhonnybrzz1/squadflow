import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getCachedPricing, clearPricingCache } from '../server/services/openrouter-pricing';
import { resilientInsert } from '../server/utils/db-retry-helper';
import { dbHelper } from '../server/db';
import { sql } from 'drizzle-orm';
import { logger } from '../server/utils/logger';
import { aiUsageTracker } from '../server/services/ai-usage-tracker';

describe('Custo Histórico Feature — Testes Unitários e Integração', () => {
  const _originalEnv = { ...process.env };

  beforeEach(() => {
    vi.stubEnv('LLM_FORCE_OPENROUTER', 'true');
    clearPricingCache();
    // Spy on logger warnings
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    clearPricingCache();
  });

  describe('1. openrouter-pricing.ts (Unit)', () => {
    it('normaliza o modelo, faz fetch na API e cacheia por 24h', async () => {
      // Mock fetch global
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'anthropic/claude-opus-4.8',
              pricing: {
                prompt: '0.000015', // $15 por milhão
                completion: '0.000075', // $75 por milhão
              },
            },
          ],
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      // 1. First call (cache miss)
      // "us.anthropic.claude-opus-4-8" must translate to "anthropic/claude-opus-4.8"
      const pricing1 = await getCachedPricing('us.anthropic.claude-opus-4-8');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(pricing1).not.toBeNull();
      expect(pricing1?.inputUsdPer1M).toBe(15);
      expect(pricing1?.outputUsdPer1M).toBe(75);

      // 2. Second call (cache hit - no second fetch)
      const pricing2 = await getCachedPricing('anthropic.claude-opus-4-8');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(pricing2).not.toBeNull();
      expect(pricing2?.inputUsdPer1M).toBe(15);
    });

    it('retorna null se a API falhar (fail-open)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });
      vi.stubGlobal('fetch', mockFetch);

      const pricing = await getCachedPricing('gpt-4');
      expect(pricing).toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // These tests depend on a `usage_records` SQLite table and an `ensureSchema`
  // method on AIUsageTracker that were removed when the tracker became
  // in-memory only. The SQL aggregation feature they exercise no longer exists
  // in the current architecture. Skipped until the persistence layer is
  // restored or these tests are rewritten against the in-memory tracker.
  describe.skip('2. Derivação de agent_name & AIUsageTracker Integration', () => {
    it('extrai nome do agente a partir da operação se iniciar com agent_interaction', async () => {
      // We simulate record trigger
      const mockRecord: any = {
        requestId: 'test_req_123',
        timestamp: new Date().toISOString(),
        demandId: 42,
        operation: 'agent_interaction:ux_specialist',
        model: 'openai/gpt-5.4-nano',
        promptTokens: 1000,
        completionTokens: 2000,
        totalTokens: 3000,
        estimatedCostUsd: 0.1,
        cacheHit: false,
      };

      // Spy pricing to return null so it falls back to static calculation
      const mockPricingFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });
      vi.stubGlobal('fetch', mockPricingFetch);

      // Pre-initialize schema in test db
      const tracker: any = aiUsageTracker;
      await tracker.ensureSchema();

      // Trigger tracking
      tracker.record(mockRecord);

      // Let asynchronous resilientInsert run
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Query database to check derived agent_name
      const rows = await dbHelper.all<{ agent_name: string; demand_id: number }>(sql`
        SELECT agent_name, demand_id FROM usage_records WHERE record_id = 'test_req_123'
      `);

      expect(rows).toHaveLength(1);
      expect(rows[0].agent_name).toBe('ux_specialist');
      expect(rows[0].demand_id).toBe(42);
    });

    it('deixa agent_name nulo para outras operações', async () => {
      const mockRecord: any = {
        requestId: 'test_req_456',
        timestamp: new Date().toISOString(),
        operation: 'embedding_generation',
        model: 'text-embedding-3-small',
        promptTokens: 500,
        completionTokens: 0,
        totalTokens: 500,
        estimatedCostUsd: 0.00001,
        cacheHit: true,
      };

      const tracker: any = aiUsageTracker;
      tracker.record(mockRecord);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const rows = await dbHelper.all<{ agent_name: string | null }>(sql`
        SELECT agent_name FROM usage_records WHERE record_id = 'test_req_456'
      `);

      expect(rows).toHaveLength(1);
      expect(rows[0].agent_name).toBeNull();
    });
  });

  describe('3. resilientInsert (Integration)', () => {
    it('executa insert no SQLite de teste e nunca lanca erros em falhas', async () => {
      let insertCount = 0;
      const insertFn = async () => {
        insertCount++;
      };

      await resilientInsert('test_op_success', insertFn);
      expect(insertCount).toBe(1);

      // Simulate failure scenario with retry
      let failedAttempts = 0;
      const failFn = async () => {
        failedAttempts++;
        throw new Error('Database locked');
      };

      // Call resilientInsert - should fail but never throw
      await expect(
        resilientInsert('test_op_fail', failFn, { maxRetries: 2, baseBackoffMs: 5 }),
      ).resolves.not.toThrow();

      // Attempt 0 + retry 1 + retry 2 = 3 times
      expect(failedAttempts).toBe(3);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // Skipped for the same reason as section 2 above: the `usage_records` table
  // and `ensureSchema` method were removed when AIUsageTracker became
  // in-memory only. The SQL aggregation tests have no backing table to query.
  describe.skip('4. Historico e Agregacoes SQL (Integration)', () => {
    beforeEach(async () => {
      // Clear usage_records before running query aggregation tests
      const tracker: any = aiUsageTracker;
      await tracker.ensureSchema();
      await dbHelper.run(sql`DELETE FROM usage_records`);
    });

    it('agrega dados corretamente agrupados por modelo, agente e demanda nas janelas', async () => {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
      const fifteenDaysAgo = now - 15 * 24 * 60 * 60 * 1000;

      // Seed records directly into test DB
      const seedData = [
        // Today
        {
          id: 'r1',
          ts: oneHourAgo,
          demand: 1,
          op: 'agent_interaction:po',
          model: 'gpt-4o',
          cost: 0.5,
          hits: 0,
        },
        {
          id: 'r2',
          ts: oneHourAgo,
          demand: 1,
          op: 'agent_interaction:po',
          model: 'gpt-4o',
          cost: 0.5,
          hits: 1,
        },
        {
          id: 'r3',
          ts: oneHourAgo,
          demand: 2,
          op: 'agent_interaction:qa',
          model: 'gpt-4o-mini',
          cost: 0.1,
          hits: 0,
        },
        // 2 days ago
        {
          id: 'r4',
          ts: twoDaysAgo,
          demand: 2,
          op: 'agent_interaction:qa',
          model: 'gpt-4o-mini',
          cost: 0.2,
          hits: 0,
        },
        // 15 days ago
        {
          id: 'r5',
          ts: fifteenDaysAgo,
          demand: 3,
          op: 'agent_interaction:ux',
          model: 'gpt-4o',
          cost: 0.8,
          hits: 0,
        },
      ];

      for (const r of seedData) {
        await dbHelper.run(sql`
          INSERT INTO usage_records (
            record_id, timestamp, demand_id, operation, model, agent_name,
            prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd,
            cache_hit, created_at
          ) VALUES (
            ${r.id}, ${r.ts}, ${r.demand}, ${r.op}, ${r.model}, ${r.op.split(':')[1]},
            100, 100, 200, ${r.cost}, ${r.hits}, ${now}
          )
        `);
      }

      // Query window 7d grouped by model
      const cutoff7d = now - 7 * 24 * 60 * 60 * 1000;
      const modelRows = await dbHelper.all<any>(sql`
        SELECT 
          model as group_key,
          COUNT(record_id) as request_count,
          SUM(estimated_cost_usd) as estimated_cost_usd,
          SUM(cache_hit) as cache_hits
        FROM usage_records
        WHERE timestamp >= ${cutoff7d}
        GROUP BY model
        ORDER BY estimated_cost_usd DESC
      `);

      expect(modelRows).toHaveLength(2);
      // gpt-4o has total cost = 1.0 (r1 + r2) within 7 days. r5 (15 days ago) is excluded!
      expect(modelRows[0].group_key).toBe('gpt-4o');
      expect(modelRows[0].request_count).toBe(2);
      expect(modelRows[0].estimated_cost_usd).toBeCloseTo(1.0, 5);
      expect(modelRows[0].cache_hits).toBe(1);

      // gpt-4o-mini has total cost = 0.3 (r3 + r4)
      expect(modelRows[1].group_key).toBe('gpt-4o-mini');
      expect(modelRows[1].request_count).toBe(2);
      expect(modelRows[1].estimated_cost_usd).toBeCloseTo(0.3, 5);

      // Query window 30d grouped by agent
      const cutoff30d = now - 30 * 24 * 60 * 60 * 1000;
      const agentRows = await dbHelper.all<any>(sql`
        SELECT 
          agent_name as group_key,
          COUNT(record_id) as request_count,
          SUM(estimated_cost_usd) as estimated_cost_usd
        FROM usage_records
        WHERE timestamp >= ${cutoff30d}
        GROUP BY agent_name
        ORDER BY estimated_cost_usd DESC
      `);

      // 30 days window includes all seed data
      expect(agentRows).toHaveLength(3); // po, qa, ux
      expect(agentRows[0].group_key).toBe('po');
      expect(agentRows[0].estimated_cost_usd).toBeCloseTo(1.0, 5); // r1 + r2
      expect(agentRows[1].group_key).toBe('ux');
      expect(agentRows[1].estimated_cost_usd).toBeCloseTo(0.8, 5); // r5
      expect(agentRows[2].group_key).toBe('qa');
      expect(agentRows[2].estimated_cost_usd).toBeCloseTo(0.3, 5); // r3 + r4
    });
  });
});
