import { createHash, randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import { dbHelper, isPostgres } from '../db';
import { logger } from '../utils/logger';

/**
 * Rerank Telemetry Service
 *
 * Structured logging and A/B test management for the rerank layer.
 * Tracks: query_hash, num_docs_retrieved, tokens, latency, cost, rerank scores,
 * and A/B group assignment.
 */

export interface RerankTelemetryEvent {
  queryHash: string;
  demandId?: number;
  agentName: string;
  abGroup: 'control' | 'rerank';
  // Retrieval metrics
  numDocsRetrieved: number;
  numDocsAfterRerank: number;
  topKRequested: number;
  // Timing
  retrievalLatencyMs: number;
  rerankLatencyMs: number;
  totalLatencyMs: number;
  // Cost
  estimatedCostUsd: number;
  rerankCostUsd: number;
  // Scores
  topScoreBefore: number;
  topScoreAfter: number;
  avgScoreBefore: number;
  avgScoreAfter: number;
  // Quality
  fallbackUsed: boolean;
  fallbackReason?: string;
  // Effective model route. `cohere-openrouter` means Cohere's cross-encoder
  // through OpenRouter's dedicated rerank endpoint; `none` = bypass/fallback.
  rerankProvider: 'cohere-openrouter' | 'none';
  // Context
  queryTokenCount: number;
}

export interface ABTestConfig {
  enabled: boolean;
  rerankGroupPercent: number; // 0-100
  testId: string;
  startDate: string;
  endDate: string;
}

const DEFAULT_AB_CONFIG: ABTestConfig = {
  enabled: false,
  rerankGroupPercent: 50,
  testId: 'rerank-ab-v1',
  startDate: new Date().toISOString(),
  endDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days
};

export class RerankTelemetryService {
  private initPromise: Promise<void>;
  private abConfig: ABTestConfig;

  constructor() {
    this.abConfig = { ...DEFAULT_AB_CONFIG };
    this.initPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.ensureSchema();
  }

  /**
   * Configure the A/B test parameters.
   */
  configureABTest(config: Partial<ABTestConfig>): void {
    this.abConfig = { ...this.abConfig, ...config };
    logger.info('Rerank A/B test configured', {
      context: { config: this.abConfig },
    });
  }

  /**
   * Determine A/B group for a given query.
   * Uses consistent hashing so the same query always goes to the same group.
   */
  assignABGroup(queryHash: string): 'control' | 'rerank' {
    if (!this.abConfig.enabled) {
      // When A/B is disabled, check if rerank is globally enabled
      const rerankEnabled = process.env.RERANK_ENABLED === 'true';
      return rerankEnabled ? 'rerank' : 'control';
    }

    // Consistent hash: use last 2 hex digits as 0-255, split by percentage
    const hashValue = parseInt(queryHash.slice(-2), 16);
    const threshold = Math.round((this.abConfig.rerankGroupPercent / 100) * 256);
    return hashValue < threshold ? 'rerank' : 'control';
  }

  /**
   * Hash a query for consistent A/B assignment and deduplication.
   */
  hashQuery(query: string): string {
    return createHash('sha256').update(query.trim().toLowerCase()).digest('hex').slice(0, 16);
  }

  /**
   * Record a telemetry event.
   */
  async recordEvent(event: RerankTelemetryEvent): Promise<void> {
    await this.initPromise;

    const eventId = randomUUID();
    const createdAt = isPostgres ? Math.floor(Date.now() / 1000) : Date.now();

    try {
      await dbHelper.run(sql`
        INSERT INTO rerank_telemetry (
          event_id, query_hash, demand_id, agent_name, ab_group,
          num_docs_retrieved, num_docs_after_rerank, top_k_requested,
          retrieval_latency_ms, rerank_latency_ms, total_latency_ms,
          estimated_cost_usd, rerank_cost_usd,
          top_score_before, top_score_after, avg_score_before, avg_score_after,
          fallback_used, fallback_reason, rerank_provider,
          query_token_count, test_id, created_at
        ) VALUES (
          ${eventId}, ${event.queryHash}, ${event.demandId ?? null}, ${event.agentName},
          ${event.abGroup},
          ${event.numDocsRetrieved}, ${event.numDocsAfterRerank}, ${event.topKRequested},
          ${event.retrievalLatencyMs}, ${event.rerankLatencyMs}, ${event.totalLatencyMs},
          ${event.estimatedCostUsd}, ${event.rerankCostUsd},
          ${event.topScoreBefore}, ${event.topScoreAfter},
          ${event.avgScoreBefore}, ${event.avgScoreAfter},
          ${event.fallbackUsed ? 1 : 0}, ${event.fallbackReason ?? null},
          ${event.rerankProvider},
          ${event.queryTokenCount}, ${this.abConfig.testId}, ${createdAt}
        )
      `);
    } catch (error) {
      logger.warn('Failed to persist rerank telemetry event', {
        error: error instanceof Error ? error : undefined,
      });
    }

    // Structured log for immediate observability
    logger.info('Rerank Telemetry', {
      context: {
        eventId,
        queryHash: event.queryHash,
        abGroup: event.abGroup,
        numDocsRetrieved: event.numDocsRetrieved,
        numDocsAfterRerank: event.numDocsAfterRerank,
        retrievalLatencyMs: event.retrievalLatencyMs,
        rerankLatencyMs: event.rerankLatencyMs,
        totalLatencyMs: event.totalLatencyMs,
        estimatedCostUsd: event.estimatedCostUsd,
        rerankCostUsd: event.rerankCostUsd,
        topScoreBefore: event.topScoreBefore,
        topScoreAfter: event.topScoreAfter,
        fallbackUsed: event.fallbackUsed,
        rerankProvider: event.rerankProvider,
        testId: this.abConfig.testId,
      },
    });

    // Cost alert: PRD rule — if cost > $0.10, log warning
    if (event.estimatedCostUsd + event.rerankCostUsd > 0.1) {
      logger.warn('Rerank cost alert: request exceeds $0.10 threshold', {
        context: {
          queryHash: event.queryHash,
          totalCost: event.estimatedCostUsd + event.rerankCostUsd,
          rerankCost: event.rerankCostUsd,
          retrievalCost: event.estimatedCostUsd,
        },
      });
    }
  }

  /**
   * Get summary metrics for dashboard.
   */
  async getMetricsSummary(testId?: string): Promise<{
    control: GroupMetrics;
    rerank: GroupMetrics;
    totalEvents: number;
    testId: string;
  }> {
    await this.initPromise;
    const tid = testId || this.abConfig.testId;

    const rows = (await dbHelper.all(sql`
      SELECT
        ab_group,
        COUNT(*) as count,
        AVG(retrieval_latency_ms) as avg_retrieval_latency,
        AVG(rerank_latency_ms) as avg_rerank_latency,
        AVG(total_latency_ms) as avg_total_latency,
        AVG(estimated_cost_usd) as avg_cost,
        AVG(rerank_cost_usd) as avg_rerank_cost,
        AVG(top_score_after) as avg_top_score,
        AVG(avg_score_after) as avg_avg_score,
        AVG(num_docs_retrieved) as avg_docs_retrieved,
        AVG(num_docs_after_rerank) as avg_docs_after_rerank,
        SUM(CASE WHEN fallback_used = 1 THEN 1 ELSE 0 END) as fallback_count
      FROM rerank_telemetry
      WHERE test_id = ${tid}
      GROUP BY ab_group
    `)) as Array<{
      ab_group: string;
      count: number;
      avg_retrieval_latency: number;
      avg_rerank_latency: number;
      avg_total_latency: number;
      avg_cost: number;
      avg_rerank_cost: number;
      avg_top_score: number;
      avg_avg_score: number;
      avg_docs_retrieved: number;
      avg_docs_after_rerank: number;
      fallback_count: number;
    }>;

    const emptyMetrics: GroupMetrics = {
      count: 0,
      avgRetrievalLatencyMs: 0,
      avgRerankLatencyMs: 0,
      avgTotalLatencyMs: 0,
      avgCostUsd: 0,
      avgRerankCostUsd: 0,
      avgTopScore: 0,
      avgAvgScore: 0,
      avgDocsRetrieved: 0,
      avgDocsAfterRerank: 0,
      fallbackRate: 0,
    };

    let control = { ...emptyMetrics };
    let rerank = { ...emptyMetrics };

    for (const row of rows) {
      const metrics: GroupMetrics = {
        count: row.count,
        avgRetrievalLatencyMs: Math.round(row.avg_retrieval_latency || 0),
        avgRerankLatencyMs: Math.round(row.avg_rerank_latency || 0),
        avgTotalLatencyMs: Math.round(row.avg_total_latency || 0),
        avgCostUsd: Number((row.avg_cost || 0).toFixed(4)),
        avgRerankCostUsd: Number((row.avg_rerank_cost || 0).toFixed(4)),
        avgTopScore: Number((row.avg_top_score || 0).toFixed(4)),
        avgAvgScore: Number((row.avg_avg_score || 0).toFixed(4)),
        avgDocsRetrieved: Math.round(row.avg_docs_retrieved || 0),
        avgDocsAfterRerank: Math.round(row.avg_docs_after_rerank || 0),
        fallbackRate: row.count > 0 ? Number((row.fallback_count / row.count).toFixed(4)) : 0,
      };

      if (row.ab_group === 'control') control = metrics;
      else if (row.ab_group === 'rerank') rerank = metrics;
    }

    return {
      control,
      rerank,
      totalEvents: (control.count || 0) + (rerank.count || 0),
      testId: tid,
    };
  }

  private async ensureSchema(): Promise<void> {
    try {
      await dbHelper.run(sql`
        CREATE TABLE IF NOT EXISTS rerank_telemetry (
          event_id TEXT PRIMARY KEY NOT NULL,
          query_hash TEXT NOT NULL,
          demand_id INTEGER,
          agent_name TEXT NOT NULL,
          ab_group TEXT NOT NULL,
          num_docs_retrieved INTEGER NOT NULL,
          num_docs_after_rerank INTEGER NOT NULL,
          top_k_requested INTEGER NOT NULL,
          retrieval_latency_ms INTEGER NOT NULL,
          rerank_latency_ms INTEGER NOT NULL,
          total_latency_ms INTEGER NOT NULL,
          estimated_cost_usd REAL NOT NULL,
          rerank_cost_usd REAL NOT NULL,
          top_score_before REAL NOT NULL,
          top_score_after REAL NOT NULL,
          avg_score_before REAL NOT NULL,
          avg_score_after REAL NOT NULL,
          fallback_used INTEGER NOT NULL DEFAULT 0,
          fallback_reason TEXT,
          rerank_provider TEXT NOT NULL,
          query_token_count INTEGER NOT NULL,
          test_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
    } catch (error) {
      logger.warn('Could not ensure rerank_telemetry schema', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }
}

export interface GroupMetrics {
  count: number;
  avgRetrievalLatencyMs: number;
  avgRerankLatencyMs: number;
  avgTotalLatencyMs: number;
  avgCostUsd: number;
  avgRerankCostUsd: number;
  avgTopScore: number;
  avgAvgScore: number;
  avgDocsRetrieved: number;
  avgDocsAfterRerank: number;
  fallbackRate: number;
}

export const rerankTelemetryService = new RerankTelemetryService();
