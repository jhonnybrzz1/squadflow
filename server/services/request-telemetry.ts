import { resolvePath } from '@shared/utils/paths';
import { sql } from 'drizzle-orm';
import * as fs from 'fs';
import { dbHelper, isPostgres } from '../db';
import { logger } from '../utils/logger';

/**
 * Request Telemetry Service
 *
 * Persistent logging of AI request metadata for cost/latency/error analysis.
 * PRD rules:
 * - Log: model_used, latency_ms, cost, task_type (inferred + provided), error
 * - NO content (prompt/response) is stored — only metadata
 * - Log must not add > 50ms to the main flow (fire-and-forget)
 * - Feature flag CLASSIFICATION_ENABLED controls task_type inference
 * - Auto-disable classification if accuracy < 60% after 200 requests
 */

export type TaskType = 'simple' | 'intermediate' | 'complex' | 'critical' | 'unknown';

export interface RequestTelemetryEvent {
  requestId: string;
  demandId?: number;
  model: string;
  provider: string;
  operation: string;
  // Timing
  latencyMs: number;
  // Cost
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  // Classification
  taskTypeInferred: TaskType;
  taskTypeProvided: TaskType | null;
  classificationConfidence: number;
  // Routing
  routingMode: string;
  routingReason: string | null;
  // Errors
  error: boolean;
  errorType: string | null;
  fallbackUsed: boolean;
  // Cache
  cacheHit: boolean;
}

export interface TaskTypeMetrics {
  taskType: string;
  count: number;
  avgLatencyMs: number;
  avgCostUsd: number;
  totalCostUsd: number;
  errorCount: number;
  errorRate: number;
  fallbackCount: number;
  fallbackRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

export interface MetricsReport {
  byTaskType: TaskTypeMetrics[];
  byModel: Array<{
    model: string;
    count: number;
    avgLatencyMs: number;
    avgCostUsd: number;
    totalCostUsd: number;
    errorRate: number;
  }>;
  classificationAccuracy: {
    totalWithBothLabels: number;
    matchCount: number;
    accuracyPct: number;
    autoDisabled: boolean;
  };
  totals: {
    requestCount: number;
    totalCostUsd: number;
    avgLatencyMs: number;
    errorRate: number;
    fallbackRate: number;
    periodStartUtc: string;
    periodEndUtc: string;
  };
}

// Classification accuracy tracking
let classificationDisabledAutomatically = false;
let totalClassifiedRequests = 0;
let correctClassifications = 0;

/**
 * Check if classification is enabled via feature flag + auto-disable logic
 */
export function isClassificationEnabled(): boolean {
  if (classificationDisabledAutomatically) return false;

  // Ler do arquivo de feature flags (padrão do projeto)
  try {
    const flagsPath = resolvePath('config/feature-flags.json');
    if (fs.existsSync(flagsPath)) {
      const flags = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
      return flags.enableTaskClassification === true;
    }
  } catch (_) {
    // Fallback para variável de ambiente se JSON falhar
  }
  return process.env.CLASSIFICATION_ENABLED === 'true';
}

/**
 * Update classification accuracy tracking.
 * Auto-disables if accuracy < 60% after 200+ samples.
 */
function updateClassificationAccuracy(inferred: TaskType, provided: TaskType | null): void {
  if (!provided || provided === 'unknown') return;

  totalClassifiedRequests++;
  if (inferred === provided) {
    correctClassifications++;
  }

  // Auto-disable check after 200 requests (PRD rule)
  if (totalClassifiedRequests >= 200) {
    const accuracy = correctClassifications / totalClassifiedRequests;
    if (accuracy < 0.6) {
      classificationDisabledAutomatically = true;
      logger.warn('Classification auto-disabled: accuracy below 60%', {
        context: {
          accuracy: Math.round(accuracy * 100),
          totalSamples: totalClassifiedRequests,
          correctSamples: correctClassifications,
        },
      });
    }
  }
}

export class RequestTelemetryService {
  private initPromise: Promise<void>;

  constructor() {
    this.initPromise = this.ensureSchema();
  }

  /**
   * Record a request telemetry event (fire-and-forget, non-blocking).
   */
  async recordEvent(event: RequestTelemetryEvent): Promise<void> {
    await this.initPromise;

    // Track classification accuracy
    if (event.taskTypeProvided) {
      updateClassificationAccuracy(event.taskTypeInferred, event.taskTypeProvided);
    }

    const createdAt = isPostgres ? Math.floor(Date.now() / 1000) : Date.now();

    try {
      await dbHelper.run(sql`
        INSERT INTO ai_requests (
          request_id, demand_id, model, provider, operation,
          latency_ms, prompt_tokens, completion_tokens, total_tokens,
          estimated_cost_usd,
          task_type_inferred, task_type_provided, classification_confidence,
          routing_mode, routing_reason,
          error, error_type, fallback_used, cache_hit,
          created_at
        ) VALUES (
          ${event.requestId},
          ${event.demandId ?? null},
          ${event.model},
          ${event.provider},
          ${event.operation},
          ${event.latencyMs},
          ${event.promptTokens},
          ${event.completionTokens},
          ${event.totalTokens},
          ${event.estimatedCostUsd ?? null},
          ${event.taskTypeInferred},
          ${event.taskTypeProvided ?? null},
          ${event.classificationConfidence},
          ${event.routingMode},
          ${event.routingReason ?? null},
          ${event.error ? 1 : 0},
          ${event.errorType ?? null},
          ${event.fallbackUsed ? 1 : 0},
          ${event.cacheHit ? 1 : 0},
          ${createdAt}
        )
      `);
    } catch (error) {
      logger.warn('Failed to persist request telemetry event', {
        error: error instanceof Error ? error : undefined,
        context: { requestId: event.requestId },
      });
    }
  }

  /**
   * Get metrics report aggregated by task_type and model.
   * PRD requirement: must respond in < 5 seconds.
   */
  async getMetricsReport(
    options: {
      sinceMs?: number;
      limitDays?: number;
    } = {},
  ): Promise<MetricsReport> {
    await this.initPromise;

    const now = Date.now();
    const sinceMs =
      options.sinceMs ||
      (options.limitDays
        ? now - options.limitDays * 24 * 60 * 60 * 1000
        : now - 14 * 24 * 60 * 60 * 1000); // default: 14 days

    const sinceValue = isPostgres ? Math.floor(sinceMs / 1000) : sinceMs;

    // By task_type
    const taskTypeRows = (await dbHelper.all(sql`
      SELECT
        task_type_inferred as task_type,
        COUNT(*) as count,
        AVG(latency_ms) as avg_latency_ms,
        AVG(CASE WHEN estimated_cost_usd IS NOT NULL THEN estimated_cost_usd ELSE 0 END) as avg_cost_usd,
        SUM(CASE WHEN estimated_cost_usd IS NOT NULL THEN estimated_cost_usd ELSE 0 END) as total_cost_usd,
        SUM(CASE WHEN error = 1 THEN 1 ELSE 0 END) as error_count,
        SUM(CASE WHEN fallback_used = 1 THEN 1 ELSE 0 END) as fallback_count
      FROM ai_requests
      WHERE created_at >= ${sinceValue}
      GROUP BY task_type_inferred
      ORDER BY count DESC
    `)) as Array<{
      task_type: string;
      count: number;
      avg_latency_ms: number;
      avg_cost_usd: number;
      total_cost_usd: number;
      error_count: number;
      fallback_count: number;
    }>;

    // By model
    const modelRows = (await dbHelper.all(sql`
      SELECT
        model,
        COUNT(*) as count,
        AVG(latency_ms) as avg_latency_ms,
        AVG(CASE WHEN estimated_cost_usd IS NOT NULL THEN estimated_cost_usd ELSE 0 END) as avg_cost_usd,
        SUM(CASE WHEN estimated_cost_usd IS NOT NULL THEN estimated_cost_usd ELSE 0 END) as total_cost_usd,
        SUM(CASE WHEN error = 1 THEN 1 ELSE 0 END) as error_count
      FROM ai_requests
      WHERE created_at >= ${sinceValue}
      GROUP BY model
      ORDER BY count DESC
    `)) as Array<{
      model: string;
      count: number;
      avg_latency_ms: number;
      avg_cost_usd: number;
      total_cost_usd: number;
      error_count: number;
    }>;

    // Classification accuracy
    const accuracyRows = (await dbHelper.all(sql`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN task_type_inferred = task_type_provided THEN 1 ELSE 0 END) as match_count
      FROM ai_requests
      WHERE task_type_provided IS NOT NULL
        AND task_type_provided != 'unknown'
        AND created_at >= ${sinceValue}
    `)) as Array<{ total: number; match_count: number }>;

    // Totals
    const totalRows = (await dbHelper.all(sql`
      SELECT
        COUNT(*) as request_count,
        SUM(CASE WHEN estimated_cost_usd IS NOT NULL THEN estimated_cost_usd ELSE 0 END) as total_cost,
        AVG(latency_ms) as avg_latency,
        SUM(CASE WHEN error = 1 THEN 1 ELSE 0 END) as error_count,
        SUM(CASE WHEN fallback_used = 1 THEN 1 ELSE 0 END) as fallback_count,
        MIN(created_at) as min_created,
        MAX(created_at) as max_created
      FROM ai_requests
      WHERE created_at >= ${sinceValue}
    `)) as Array<{
      request_count: number;
      total_cost: number;
      avg_latency: number;
      error_count: number;
      fallback_count: number;
      min_created: number;
      max_created: number;
    }>;

    const byTaskType: TaskTypeMetrics[] = taskTypeRows.map((row) => ({
      taskType: row.task_type,
      count: row.count,
      avgLatencyMs: Math.round(row.avg_latency_ms || 0),
      avgCostUsd: Number((row.avg_cost_usd || 0).toFixed(6)),
      totalCostUsd: Number((row.total_cost_usd || 0).toFixed(6)),
      errorCount: row.error_count || 0,
      errorRate: row.count > 0 ? Number(((row.error_count || 0) / row.count).toFixed(4)) : 0,
      fallbackCount: row.fallback_count || 0,
      fallbackRate: row.count > 0 ? Number(((row.fallback_count || 0) / row.count).toFixed(4)) : 0,
      p50LatencyMs: 0, // Would need percentile query or in-memory calc
      p95LatencyMs: 0,
    }));

    const byModel = modelRows.map((row) => ({
      model: row.model,
      count: row.count,
      avgLatencyMs: Math.round(row.avg_latency_ms || 0),
      avgCostUsd: Number((row.avg_cost_usd || 0).toFixed(6)),
      totalCostUsd: Number((row.total_cost_usd || 0).toFixed(6)),
      errorRate: row.count > 0 ? Number(((row.error_count || 0) / row.count).toFixed(4)) : 0,
    }));

    const accuracyRow = accuracyRows[0] || { total: 0, match_count: 0 };
    const classificationAccuracy = {
      totalWithBothLabels: accuracyRow.total || 0,
      matchCount: accuracyRow.match_count || 0,
      accuracyPct:
        accuracyRow.total > 0
          ? Number(((accuracyRow.match_count / accuracyRow.total) * 100).toFixed(1))
          : 0,
      autoDisabled: classificationDisabledAutomatically,
    };

    const totalsRow = totalRows[0] || {
      request_count: 0,
      total_cost: 0,
      avg_latency: 0,
      error_count: 0,
      fallback_count: 0,
      min_created: now,
      max_created: now,
    };

    const toIso = (ts: number) => {
      const ms = isPostgres ? ts * 1000 : ts;
      return new Date(ms).toISOString();
    };

    return {
      byTaskType,
      byModel,
      classificationAccuracy,
      totals: {
        requestCount: totalsRow.request_count || 0,
        totalCostUsd: Number((totalsRow.total_cost || 0).toFixed(6)),
        avgLatencyMs: Math.round(totalsRow.avg_latency || 0),
        errorRate:
          totalsRow.request_count > 0
            ? Number(((totalsRow.error_count || 0) / totalsRow.request_count).toFixed(4))
            : 0,
        fallbackRate:
          totalsRow.request_count > 0
            ? Number(((totalsRow.fallback_count || 0) / totalsRow.request_count).toFixed(4))
            : 0,
        periodStartUtc: toIso(totalsRow.min_created || sinceMs),
        periodEndUtc: toIso(totalsRow.max_created || now),
      },
    };
  }

  /**
   * Cost dashboard shaped data read directly from the persistent `ai_requests` table.
   *
   * This is the "historical" source — survives restarts, unlike the in-memory
   * `aiUsageTracker` hot cache. Used by `/api/admin/costs?source=persistent` and
   * as the auto-fallback when the RAM tracker is empty right after a restart.
   *
   * NOTE on cacheSavings: `ai_requests` records `cache_hit` but NOT tokens/cost
   * saved, so `tokensSaved`/`costSavedUsd` are reported as 0 here. Those savings
   * figures remain available only from the live in-memory tracker.
   */
  async getCostHistory(options: { limitDays?: number } = {}): Promise<{
    summary: {
      totalCostUsd: number;
      totalRequests: number;
      totalTokens: number;
      avgCostPerRequest: number;
      costSavedUsd: number;
    };
    costByModel: Array<{
      model: string;
      requestCount: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      estimatedCostUsd: number;
      avgCostPerRequest: number;
    }>;
    timeline: Array<{ bucket: string; cost: number; requests: number }>;
    cacheSavings: {
      exactHits: number;
      tokensSaved: number;
      costSavedUsd: number;
      cacheHitRate: number;
    };
    routingEfficiency: {
      economicRequests: number;
      safeRequests: number;
      fallbackRate: number;
      economicRatio: number;
    };
    timestamp: string;
    source: 'persistent';
    windowDays: number;
  }> {
    await this.initPromise;

    const limitDays = options.limitDays ?? 7;
    const now = Date.now();
    const sinceMs = now - limitDays * 24 * 60 * 60 * 1000;
    const sinceValue = isPostgres ? Math.floor(sinceMs / 1000) : sinceMs;

    // By model
    const modelRows = (await dbHelper.all(sql`
      SELECT
        model,
        COUNT(*) as request_count,
        SUM(prompt_tokens) as prompt_tokens,
        SUM(completion_tokens) as completion_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(CASE WHEN estimated_cost_usd IS NOT NULL THEN estimated_cost_usd ELSE 0 END) as estimated_cost_usd
      FROM ai_requests
      WHERE created_at >= ${sinceValue}
      GROUP BY model
      ORDER BY estimated_cost_usd DESC
    `)) as Array<{
      model: string;
      request_count: number;
      prompt_tokens: number | null;
      completion_tokens: number | null;
      total_tokens: number | null;
      estimated_cost_usd: number | null;
    }>;

    const costByModel = modelRows.map((row) => {
      const requestCount = row.request_count || 0;
      const estimatedCostUsd = Number((row.estimated_cost_usd || 0).toFixed(8));
      return {
        model: row.model,
        requestCount,
        promptTokens: row.prompt_tokens || 0,
        completionTokens: row.completion_tokens || 0,
        totalTokens: row.total_tokens || 0,
        estimatedCostUsd,
        avgCostPerRequest:
          requestCount > 0 ? Number((estimatedCostUsd / requestCount).toFixed(8)) : 0,
      };
    });

    // Totals
    const totalRows = (await dbHelper.all(sql`
      SELECT
        COUNT(*) as request_count,
        SUM(CASE WHEN estimated_cost_usd IS NOT NULL THEN estimated_cost_usd ELSE 0 END) as total_cost,
        SUM(total_tokens) as total_tokens,
        SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) as cache_hits
      FROM ai_requests
      WHERE created_at >= ${sinceValue}
    `)) as Array<{
      request_count: number;
      total_cost: number | null;
      total_tokens: number | null;
      cache_hits: number | null;
    }>;

    const tot = totalRows[0] || {};
    const totalRequests = tot.request_count || 0;
    const totalCostUsd = Number((tot.total_cost || 0).toFixed(8));
    const totalTokens = tot.total_tokens || 0;
    const cacheHits = tot.cache_hits || 0;

    // Routing efficiency
    const routingRows = (await dbHelper.all(sql`
      SELECT
        routing_mode,
        COUNT(*) as cnt,
        SUM(CASE WHEN fallback_used = 1 THEN 1 ELSE 0 END) as fallback_count
      FROM ai_requests
      WHERE created_at >= ${sinceValue}
      GROUP BY routing_mode
    `)) as Array<{ routing_mode: string; cnt: number; fallback_count: number | null }>;

    let economicRequests = 0;
    let safeRequests = 0;
    let fallbackCount = 0;
    for (const row of routingRows) {
      if (row.routing_mode === 'economic') economicRequests = row.cnt;
      else if (row.routing_mode === 'safe') safeRequests = row.cnt;
      fallbackCount += row.fallback_count || 0;
    }
    const routedTotal = economicRequests + safeRequests;
    const fallbackRate = routedTotal > 0 ? Number((fallbackCount / routedTotal).toFixed(4)) : 0;
    const economicRatio = routedTotal > 0 ? Number((economicRequests / routedTotal).toFixed(4)) : 0;

    // Timeline bucketed by 5-min intervals (UTC HH:MM)
    const timelineRows = (await dbHelper.all(sql`
      SELECT created_at, estimated_cost_usd
      FROM ai_requests
      WHERE created_at >= ${sinceValue}
    `)) as Array<{ created_at: number; estimated_cost_usd: number | null }>;

    const bucketMap = new Map<string, { cost: number; requests: number }>();
    for (const row of timelineRows) {
      const tsMs = isPostgres ? row.created_at * 1000 : row.created_at;
      const d = new Date(tsMs);
      const bucket = `${d.getUTCHours().toString().padStart(2, '0')}:${(Math.floor(d.getUTCMinutes() / 5) * 5).toString().padStart(2, '0')}`;
      const entry = bucketMap.get(bucket) || { cost: 0, requests: 0 };
      entry.cost += row.estimated_cost_usd || 0;
      entry.requests += 1;
      bucketMap.set(bucket, entry);
    }
    const timeline = Array.from(bucketMap.entries())
      .map(([bucket, data]) => ({
        bucket,
        cost: Number(data.cost.toFixed(8)),
        requests: data.requests,
      }))
      .sort((a, b) => a.bucket.localeCompare(b.bucket));

    return {
      summary: {
        totalCostUsd,
        totalRequests,
        totalTokens,
        avgCostPerRequest:
          totalRequests > 0 ? Number((totalCostUsd / totalRequests).toFixed(8)) : 0,
        costSavedUsd: 0, // Not persisted in ai_requests; available only from live tracker
      },
      costByModel,
      timeline,
      cacheSavings: {
        exactHits: cacheHits,
        tokensSaved: 0, // Not persisted in ai_requests
        costSavedUsd: 0, // Not persisted in ai_requests
        cacheHitRate: totalRequests > 0 ? Number((cacheHits / totalRequests).toFixed(4)) : 0,
      },
      routingEfficiency: {
        economicRequests,
        safeRequests,
        fallbackRate,
        economicRatio,
      },
      timestamp: new Date().toISOString(),
      source: 'persistent',
      windowDays: limitDays,
    };
  }

  /**
   * Get classification accuracy stats (for auto-disable monitoring).
   */
  getClassificationStats(): {
    totalClassified: number;
    correctClassifications: number;
    accuracyPct: number;
    autoDisabled: boolean;
  } {
    return {
      totalClassified: totalClassifiedRequests,
      correctClassifications,
      accuracyPct:
        totalClassifiedRequests > 0
          ? Math.round((correctClassifications / totalClassifiedRequests) * 100)
          : 0,
      autoDisabled: classificationDisabledAutomatically,
    };
  }

  private async ensureSchema(): Promise<void> {
    try {
      await dbHelper.run(sql`
        CREATE TABLE IF NOT EXISTS ai_requests (
          request_id TEXT PRIMARY KEY NOT NULL,
          demand_id INTEGER,
          model TEXT NOT NULL,
          provider TEXT NOT NULL,
          operation TEXT NOT NULL,
          latency_ms INTEGER NOT NULL,
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          estimated_cost_usd REAL,
          task_type_inferred TEXT NOT NULL DEFAULT 'unknown',
          task_type_provided TEXT,
          classification_confidence REAL NOT NULL DEFAULT 0,
          routing_mode TEXT NOT NULL DEFAULT 'unknown',
          routing_reason TEXT,
          error INTEGER NOT NULL DEFAULT 0,
          error_type TEXT,
          fallback_used INTEGER NOT NULL DEFAULT 0,
          cache_hit INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        )
      `);

      // Index for efficient metrics queries
      await dbHelper.run(sql`
        CREATE INDEX IF NOT EXISTS idx_ai_requests_created_at ON ai_requests(created_at)
      `);
      await dbHelper.run(sql`
        CREATE INDEX IF NOT EXISTS idx_ai_requests_task_type ON ai_requests(task_type_inferred)
      `);
      await dbHelper.run(sql`
        CREATE INDEX IF NOT EXISTS idx_ai_requests_model ON ai_requests(model)
      `);
    } catch (error) {
      logger.warn('Could not ensure ai_requests schema', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }
}

export const requestTelemetryService = new RequestTelemetryService();
