/**
 * LLM Metrics Collector
 *
 * Coleta e persiste métricas do pipeline LLM em SQLite/Postgres.
 * - Schema híbrido: colunas fixas + metadata JSON.
 * - Batch insert assíncrono: 50 registros ou 5s.
 * - Feature flag ENABLE_LLM_METRICS.
 * - JSON malformado → metadata NULL.
 */

import { sql } from 'drizzle-orm';
import { AgentRole } from '@shared/agent-roles';
import { dbHelper } from '../db';
import { logger } from '../utils/logger';

export interface LlmMetricRecord {
  provider?: string;
  model?: string;
  latencyMs?: number;
  errorFlag?: boolean;
  cacheHit?: boolean;
  costEstimate?: number | null;
  operationType?: string;
  demandId?: number | null;
  requestId?: string | null;
  agentName?: string | null;
  /** Metadata livre em JSON. */
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

export class LlmMetricsCollector {
  private tableReady = false;
  private buffer: LlmMetricRecord[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly maxBufferSize = 50;
  private readonly flushIntervalMs = 5_000;

  private get isEnabled(): boolean {
    return process.env.ENABLE_LLM_METRICS === 'true';
  }

  async ensureTable(): Promise<void> {
    if (this.tableReady) return;
    try {
      await dbHelper.run(sql`
        CREATE TABLE IF NOT EXISTS llm_operations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT,
          model TEXT,
          latency_ms INTEGER,
          error_flag INTEGER NOT NULL DEFAULT 0,
          cache_hit INTEGER NOT NULL DEFAULT 0,
          cost_estimate REAL,
          operation_type TEXT,
          demand_id INTEGER,
          request_id TEXT,
          agent_name TEXT,
          metadata TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
      await dbHelper.run(
        sql`CREATE INDEX IF NOT EXISTS idx_llm_operations_created_at ON llm_operations(created_at)`,
      );
      await dbHelper.run(
        sql`CREATE INDEX IF NOT EXISTS idx_llm_operations_provider ON llm_operations(provider)`,
      );
      this.tableReady = true;
    } catch (error) {
      logger.warn('M-1/A-2: could not create llm_operations table', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  record(record: LlmMetricRecord): void {
    if (!this.isEnabled) return;

    this.buffer.push(record);

    if (this.buffer.length >= this.maxBufferSize) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        void this.flush();
      }, this.flushIntervalMs);
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    await this.ensureTable();

    const batch = this.buffer.splice(0, this.buffer.length);
    const now = Math.floor(Date.now() / 1000);

    for (const record of batch) {
      let metadataJson: string | null = null;
      if (record.metadata) {
        try {
          metadataJson = JSON.stringify(record.metadata);
        } catch (_) {
          metadataJson = null;
        }
      }

      try {
        await dbHelper.run(sql`
          INSERT INTO llm_operations (
            provider, model, latency_ms, error_flag, cache_hit, cost_estimate,
            operation_type, demand_id, request_id, agent_name, metadata, created_at
          )
          VALUES (
            ${record.provider ?? null},
            ${record.model ?? null},
            ${record.latencyMs ?? null},
            ${record.errorFlag ? 1 : 0},
            ${record.cacheHit ? 1 : 0},
            ${record.costEstimate ?? null},
            ${record.operationType ?? null},
            ${record.demandId ?? null},
            ${record.requestId ?? null},
            ${record.agentName ?? null},
            ${metadataJson},
            ${record.createdAt ?? now}
          )
        `);
      } catch (error) {
        logger.warn('A-2: failed to insert llm metric', {
          error: error instanceof Error ? error : undefined,
          context: { requestId: record.requestId, operationType: record.operationType },
        });
      }
    }
  }

  async getSummary(): Promise<{
    total: number;
    avgLatencyMs: number | null;
    p95LatencyMs: number | null;
    errorRate: number;
    cacheHitRate: number;
    costByProvider: Record<string, number>;
  }> {
    await this.ensureTable();

    const total = await dbHelper.get<{ count: number }>(
      sql`SELECT COUNT(*) as count FROM llm_operations`,
    );
    const count = total?.count ?? 0;

    if (count === 0) {
      return {
        total: 0,
        avgLatencyMs: null,
        p95LatencyMs: null,
        errorRate: 0,
        cacheHitRate: 0,
        costByProvider: {},
      };
    }

    const [latency, errors, cacheHits, costByProvider] = await Promise.all([
      dbHelper.get<{
        avg: number | null;
        p95: number | null;
      }>(sql`
        SELECT
          AVG(latency_ms) as avg,
          (SELECT latency_ms FROM llm_operations WHERE latency_ms IS NOT NULL ORDER BY latency_ms LIMIT 1 OFFSET ${Math.floor(count * 0.95)}) as p95
        FROM llm_operations
      `),
      dbHelper.get<{ error_count: number }>(
        sql`SELECT COUNT(*) as error_count FROM llm_operations WHERE error_flag = 1`,
      ),
      dbHelper.get<{ hit_count: number }>(
        sql`SELECT COUNT(*) as hit_count FROM llm_operations WHERE cache_hit = 1`,
      ),
      dbHelper.all<{ provider: string; total_cost: number }>(sql`
        SELECT provider, COALESCE(SUM(cost_estimate), 0) as total_cost
        FROM llm_operations
        WHERE provider IS NOT NULL
        GROUP BY provider
      `),
    ]);

    return {
      total: count,
      avgLatencyMs: latency?.avg ?? null,
      p95LatencyMs: latency?.p95 ?? null,
      errorRate: count > 0 ? (errors?.error_count ?? 0) / count : 0,
      cacheHitRate: count > 0 ? (cacheHits?.hit_count ?? 0) / count : 0,
      costByProvider: Object.fromEntries(costByProvider.map((r) => [r.provider, r.total_cost])),
    };
  }

  async seedSyntheticData(): Promise<void> {
    await this.ensureTable();

    // Limpar dados anteriores de seed
    await dbHelper.run(sql`DELETE FROM llm_operations WHERE request_id LIKE 'seed-%'`);

    const base: LlmMetricRecord[] = [];
    const now = Math.floor(Date.now() / 1000);

    for (let i = 0; i < 40; i++) {
      const group = i % 3;
      const provider = i % 2 === 0 ? 'openrouter' : 'openai';
      const model = i % 2 === 0 ? 'gpt-4o' : 'deepseek/deepseek-v4-pro';
      const latencyMs = 200 + i * 10 + Math.floor(Math.random() * 50);
      const errorFlag = i % 7 === 0;
      const cacheHit = i % 5 === 0;
      const costEstimate = cacheHit ? 0 : Math.random() * 0.01;

      let metadata: Record<string, unknown> | undefined;
      if (group === 1) {
        metadata = { source: 'seed', group: 'with_metadata', note: 'dados sintéticos' };
      } else if (group === 2) {
        metadata = { malformed: 'this is fine' };
      }

      base.push({
        provider,
        model,
        latencyMs,
        errorFlag,
        cacheHit,
        costEstimate,
        operationType: 'chat_completion',
        demandId: 10000 + i,
        requestId: `seed-${i}`,
        agentName: AgentRole.tech_lead,
        metadata,
        createdAt: now - i,
      });
    }

    for (const record of base) {
      this.record(record);
    }
    await this.flush();
  }
}

export const llmMetricsCollector = new LlmMetricsCollector();
