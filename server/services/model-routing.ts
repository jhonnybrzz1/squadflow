import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db as defaultDb, isPostgres, type DbClient } from '../db';
import { modelRoutingStageRuns } from '@shared/schema-unified';
import { type Demand } from '@shared/schema';
import type { DemandClassification } from '../orchestration-contracts';
import { dbRun } from '../utils/db-utils';
import { logger } from '../utils/logger';
import { featureFlags } from './feature-flags';
import { modelRoutingAdaptation } from '../metrics';
import { proposeAdaptiveModel } from './model-routing-policy';

export const MODEL_ROUTING_CONFIG_VERSION = 'model-routing-pilot-v1';
// Primary: DeepSeek V4 Flash for general agents, Mistral as fallback
export const MODEL_NANO =
  process.env.OPENAI_MODEL_NANO || process.env.OPENAI_MODEL_FAST || 'deepseek/deepseek-v4-pro';
export const MODEL_MINI =
  process.env.OPENAI_MODEL_MINI ||
  process.env.OPENAI_MODEL_CAPABLE ||
  (process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_MODEL_PRIMARY : null) ||
  'deepseek/deepseek-v4-pro'; // Fallback to Mistral via env if needed

export type ModelRoutingStageName = 'router' | 'template_validator' | 'qa' | `agent:${string}`;
export type ModelRoutingStatus =
  'processing' | 'completed' | 'failed' | 'fallback_triggered' | 'failed_after_retries';
export type ModelRoutingFailureReason =
  | 'schema_failed'
  | 'schema_parse_failed'
  | 'validation_failed'
  | 'qa_failed_critical'
  | 'budget_exhausted';

export interface StageRunInput {
  demandId: number;
  executionId?: string | null;
  stageName: ModelRoutingStageName;
  modelUsed: string;
  attemptIndex: number;
  status: ModelRoutingStatus;
  validationPassed?: boolean | null;
  validationErrorsCount?: number | null;
  qaPassed?: boolean | null;
  qaBlockersCount?: number | null;
  failureReason?: ModelRoutingFailureReason | null;
  finalArtifactAccepted?: boolean | null;
  metadata?: Record<string, unknown>;
}

export interface StageDecisionContext {
  demand: Pick<Demand, 'priority' | 'type'>;
  classification?: DemandClassification | null;
  stageName: ModelRoutingStageName;
}

export interface StageDecision {
  stageName: ModelRoutingStageName;
  model: string;
  reason: string;
  complexity: number;
  risk: number;
  clarity: number;
  criticality: number;
}

export interface ModelQualityScore {
  model: string;
  sampleSize: number;
  successRate: number;
  avgScore: number;
  avgLatencyMs: number | null;
}

export interface RetryBudgetState {
  maxAttemptsPerStage: number;
  maxFallbacksPerDemand: number;
  fallbackCount: number;
}

const FALLBACK_REASONS = new Set<ModelRoutingFailureReason>([
  'schema_failed',
  'schema_parse_failed',
  'validation_failed',
  'qa_failed_critical',
  'budget_exhausted',
]);

export function isModelRoutingFailureReason(value: unknown): value is ModelRoutingFailureReason {
  return typeof value === 'string' && FALLBACK_REASONS.has(value as ModelRoutingFailureReason);
}

export class ModelRoutingService {
  private readonly budgets = new Map<string, RetryBudgetState>();
  private initPromise: Promise<void>;

  constructor(private readonly database: DbClient = defaultDb) {
    this.initPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.ensureSchema();
  }

  getRetryBudget(demandId: number, executionId?: string | null): RetryBudgetState {
    const key = this.getBudgetKey(demandId, executionId);
    const current = this.budgets.get(key);
    if (current) return current;

    const budget = {
      maxAttemptsPerStage: this.parsePositiveInt(
        process.env.MODEL_ROUTING_MAX_ATTEMPTS_PER_STAGE,
        2,
      ),
      maxFallbacksPerDemand: this.parsePositiveInt(
        process.env.MODEL_ROUTING_MAX_FALLBACKS_PER_DEMAND,
        3,
      ),
      fallbackCount: 0,
    };
    this.budgets.set(key, budget);
    return budget;
  }

  classifyRouterModel(): string {
    return MODEL_NANO;
  }

  decideStageModel(context: StageDecisionContext): StageDecision {
    const criteria = context.classification?.criteria;
    const complexity = criteria?.complexity ?? this.defaultComplexity(context.demand.type);
    const risk = Math.max(criteria?.interpretationRisk ?? 0, criteria?.urgency ?? 0);
    const clarity = 100 - (criteria?.ambiguity ?? 35);
    const criticality = this.priorityCriticality(context.demand.priority);
    const requiresMini =
      context.stageName === 'qa' ||
      context.stageName === 'template_validator' ||
      complexity >= 70 ||
      risk >= 70 ||
      criticality >= 80 ||
      clarity <= 35;

    return {
      stageName: context.stageName,
      model: requiresMini ? MODEL_MINI : MODEL_NANO,
      reason: requiresMini ? 'critical_or_validation_stage' : 'low_risk_operational_stage',
      complexity,
      risk,
      clarity,
      criticality,
    };
  }

  async decideStageModelAdaptive(context: StageDecisionContext): Promise<StageDecision> {
    const base = this.decideStageModel(context);
    const flags = featureFlags.getFlags();
    if (!flags.enableAdaptiveModelRouting || MODEL_NANO === MODEL_MINI) return base;

    const minSamples = flags.adaptiveModelRoutingMinSamples;
    const [nano, mini] = await Promise.all([
      this.getRollingModelQuality(MODEL_NANO, 7),
      this.getRollingModelQuality(MODEL_MINI, 7),
    ]);
    if (nano.sampleSize < minSamples || mini.sampleSize < minSamples) return base;

    const proposal = proposeAdaptiveModel({
      baseModel: base.model,
      nanoModel: MODEL_NANO,
      miniModel: MODEL_MINI,
      nano,
      mini,
    });
    if (!proposal) return base;
    const proposed = { ...base, ...proposal };
    const shadow = flags.adaptiveModelRoutingShadowMode;
    modelRoutingAdaptation
      .labels(base.model, proposed.model, proposed.reason, shadow ? 'shadow' : 'enforced')
      .inc();
    logger.info('[AdaptiveModelRouting] model change proposed', {
      context: { stage: context.stageName, base, proposed, nano, mini, shadow },
    });
    return shadow ? base : proposed;
  }

  async getRollingModelQuality(model: string, days = 7): Promise<ModelQualityScore> {
    await this.initPromise;
    const rows = await (this.database as any)
      .select()
      .from(modelRoutingStageRuns)
      .where(eq(modelRoutingStageRuns.modelUsed, model))
      .limit(1000);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const recent = (rows as any[]).filter((row) => {
      const raw = row.createdAt ?? row.created_at;
      const numeric = Number(raw);
      const timestamp =
        raw instanceof Date
          ? raw.getTime()
          : numeric > 1_000_000_000_000
            ? numeric
            : numeric * 1000;
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
    const successes = recent.filter((row) => {
      const explicitChecks = [
        row.validationPassed ?? row.validation_passed,
        row.qaPassed ?? row.qa_passed,
        row.finalArtifactAccepted ?? row.final_artifact_accepted,
      ].filter((value) => value !== null && value !== undefined);
      return (
        row.status === 'completed' &&
        explicitChecks.every((value) => value === true || value === 1 || value === '1')
      );
    }).length;
    const latencies = recent
      .map((row) => {
        try {
          const metadata =
            typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : row.metadata;
          return Number(metadata?.latencyMs);
        } catch (_) {
          return Number.NaN;
        }
      })
      .filter((value) => Number.isFinite(value) && value >= 0);
    const successRate = recent.length > 0 ? successes / recent.length : 0;
    return {
      model,
      sampleSize: recent.length,
      successRate,
      avgScore: successRate * 100,
      avgLatencyMs:
        latencies.length > 0
          ? latencies.reduce((total, value) => total + value, 0) / latencies.length
          : null,
    };
  }

  shouldFallback(input: {
    demandId: number;
    executionId?: string | null;
    stageName: ModelRoutingStageName;
    attemptIndex: number;
    failureReason?: ModelRoutingFailureReason | null;
  }): {
    allowed: boolean;
    failureReason: ModelRoutingFailureReason;
    nextAttemptIndex: number;
    budget: RetryBudgetState;
  } {
    const budget = this.getRetryBudget(input.demandId, input.executionId);
    const requestedReason = input.failureReason || 'validation_failed';

    if (
      input.attemptIndex >= budget.maxAttemptsPerStage ||
      budget.fallbackCount >= budget.maxFallbacksPerDemand
    ) {
      return {
        allowed: false,
        failureReason: 'budget_exhausted',
        nextAttemptIndex: input.attemptIndex,
        budget,
      };
    }

    budget.fallbackCount += 1;
    return {
      allowed: true,
      failureReason: requestedReason,
      nextAttemptIndex: input.attemptIndex + 1,
      budget,
    };
  }

  async recordStageRun(input: StageRunInput): Promise<void> {
    await this.initPromise;
    const failureReason = input.failureReason ?? null;
    if (failureReason && !isModelRoutingFailureReason(failureReason)) {
      throw new Error(`Invalid model routing failure reason: ${failureReason}`);
    }

    const runId = randomUUID();
    const createdAt = isPostgres ? Math.floor(Date.now() / 1000) : new Date();
    await (this.database as any).insert(modelRoutingStageRuns).values({
      runId,
      demandId: input.demandId,
      executionId: input.executionId ?? null,
      stageName: input.stageName,
      modelUsed: input.modelUsed,
      attemptIndex: input.attemptIndex,
      status: input.status,
      validationPassed: input.validationPassed != null ? (input.validationPassed ? 1 : 0) : null,
      validationErrorsCount: input.validationErrorsCount ?? null,
      qaPassed: input.qaPassed != null ? (input.qaPassed ? 1 : 0) : null,
      qaBlockersCount: input.qaBlockersCount ?? null,
      failureReason,
      finalArtifactAccepted:
        input.finalArtifactAccepted != null ? (input.finalArtifactAccepted ? 1 : 0) : null,
      metadata: {
        configVersion: MODEL_ROUTING_CONFIG_VERSION,
        ...(input.metadata || {}),
      },
      createdAt,
    });

    logger.logBusinessEvent('model_routing_stage_run', input.stageName, runId, {
      demandId: input.demandId,
      executionId: input.executionId,
      modelUsed: input.modelUsed,
      attemptIndex: input.attemptIndex,
      status: input.status,
      failureReason,
    });
  }

  async getDemandStageRuns(demandId: number, executionId?: string | null) {
    await this.initPromise;
    const filters = [eq(modelRoutingStageRuns.demandId, demandId)];
    if (executionId) {
      filters.push(eq(modelRoutingStageRuns.executionId, executionId));
    }

    return (this.database as any)
      .select()
      .from(modelRoutingStageRuns)
      .where(and(...filters));
  }

  private defaultComplexity(type: string): number {
    return type === 'bug' ? 45 : type === 'melhoria' ? 60 : 55;
  }

  private priorityCriticality(priority: string): number {
    if (priority === 'critica') return 95;
    if (priority === 'alta') return 75;
    if (priority === 'media') return 50;
    return 25;
  }

  private getBudgetKey(demandId: number, executionId?: string | null): string {
    return `${demandId}:${executionId || 'default'}`;
  }

  private parsePositiveInt(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }

  private async ensureSchema(): Promise<void> {
    try {
      await dbRun(
        this.database,
        sql`
        CREATE TABLE IF NOT EXISTS model_routing_stage_runs (
          run_id TEXT PRIMARY KEY NOT NULL,
          demand_id INTEGER NOT NULL,
          execution_id TEXT,
          stage_name TEXT NOT NULL,
          model_used TEXT NOT NULL,
          attempt_index INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed', 'fallback_triggered', 'failed_after_retries')),
          validation_passed INTEGER,
          validation_errors_count INTEGER,
          qa_passed INTEGER,
          qa_blockers_count INTEGER,
          failure_reason TEXT CHECK(failure_reason IN ('schema_failed', 'schema_parse_failed', 'validation_failed', 'qa_failed_critical', 'budget_exhausted')),
          final_artifact_accepted INTEGER,
          metadata TEXT,
          created_at INTEGER NOT NULL
        )
      `,
      );
    } catch (error) {
      logger.warn('Não foi possível garantir schema model_routing_stage_runs', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }
}

export const modelRoutingService = new ModelRoutingService();
