/**
 * Data Retention Cleanup Worker
 *
 * Executes data retention policies by removing expired records.
 * Features:
 * - Daily automatic execution (configurable)
 * - Exponential backoff retry for SQLite busy errors
 * - Database size metrics before/after cleanup
 * - Detailed execution logging
 *
 * PRD Reference: Políticas de Retenção de Dados e Modo Conversacional Interativo
 */

import { db, dbHelper, isPostgres } from '../db';
import { logger } from '../utils/logger';
import { eq, sql } from 'drizzle-orm';
import { retentionJobLogs, type RetentionPolicy, type RetentionDataType } from '@shared/schema';
import { retentionPolicyService } from '../services/retention-policy';
import { randomUUID } from 'node:crypto';

// Configuration
const DEFAULT_SCHEDULE_HOURS = 24; // Run every 24 hours by default
const MAX_RETRY_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 1000; // 1 second base, will be 1s, 2s, 4s

// Map data types to their table deletion queries
const DATA_TYPE_DELETE_MAP: Record<
  RetentionDataType,
  {
    tableName: string;
    timestampColumn: string;
  }
> = {
  chat_messages: {
    tableName: 'demands',
    timestampColumn: 'completed_at',
  },
  telemetry: {
    tableName: 'telemetry',
    timestampColumn: 'timestamp',
  },
  document_snapshots: {
    tableName: 'document_snapshots',
    timestampColumn: 'created_at',
  },
  approval_comments: {
    tableName: 'approval_comments',
    timestampColumn: 'created_at',
  },
  document_lifecycle_events: {
    tableName: 'document_lifecycle_events',
    timestampColumn: 'created_at',
  },
  human_feedback: {
    tableName: 'human_feedback',
    timestampColumn: 'created_at',
  },
  feedback_refinamento: {
    tableName: 'feedback_refinamento',
    timestampColumn: 'criado_em',
  },
  agent_interventions: {
    tableName: 'agent_interventions',
    timestampColumn: 'criado_em',
  },
  operation_attempts: {
    tableName: 'operation_attempts',
    timestampColumn: 'created_at',
  },
  model_routing_stage_runs: {
    tableName: 'model_routing_stage_runs',
    timestampColumn: 'created_at',
  },
  agent_decision_records: {
    tableName: 'agent_decision_records',
    timestampColumn: 'created_at',
  },
  progressive_refinement_records: {
    tableName: 'progressive_refinement_records',
    timestampColumn: 'created_at',
  },
};

interface CleanupResult {
  policyId: number;
  dataType: RetentionDataType;
  rowsDeleted: number;
  success: boolean;
  error?: string;
  retryAttempts: number;
}

interface JobExecutionResult {
  runId: string;
  startedAt: Date;
  completedAt: Date;
  dbSizeBeforeMb: number;
  dbSizeAfterMb: number;
  policiesProcessed: number;
  totalRowsDeleted: number;
  results: CleanupResult[];
  errors: string[];
}

export class RetentionWorker {
  private schedulerInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  /**
   * Sleep utility with exponential backoff
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Calculate exponential backoff delay
   */
  private getBackoffDelay(attempt: number): number {
    return BASE_RETRY_DELAY_MS * Math.pow(2, attempt); // 1s, 2s, 4s
  }

  /**
   * Check if error is SQLite busy error
   */
  private isSqliteBusyError(error: unknown): boolean {
    if (error instanceof Error) {
      return (
        error.message.includes('SQLITE_BUSY') ||
        error.message.includes('database is locked') ||
        error.message.includes('busy')
      );
    }
    return false;
  }

  /**
   * Execute delete with retry logic for SQLite busy errors
   */
  private async executeWithRetry(
    policy: RetentionPolicy,
    cutoffTimestamp: number | string,
  ): Promise<CleanupResult> {
    const tableInfo = DATA_TYPE_DELETE_MAP[policy.dataType];
    if (!tableInfo) {
      return {
        policyId: policy.id,
        dataType: policy.dataType,
        rowsDeleted: 0,
        success: false,
        error: `Unknown data type: ${policy.dataType}`,
        retryAttempts: 0,
      };
    }

    let lastError: Error | null = null;
    let retryAttempt = 0;

    for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        // Count rows before deletion (for logging)
        const countResult = (await dbHelper.all(
          sql`SELECT COUNT(*) as count FROM ${sql.identifier(tableInfo.tableName)}
              WHERE ${sql.identifier(tableInfo.timestampColumn)} < ${cutoffTimestamp}`,
        )) as Array<{ count: number }>;

        const rowsToDelete = countResult[0]?.count || 0;

        if (rowsToDelete === 0) {
          return {
            policyId: policy.id,
            dataType: policy.dataType,
            rowsDeleted: 0,
            success: true,
            retryAttempts: attempt,
          };
        }

        // Execute deletion
        if (policy.action === 'delete') {
          await dbHelper.run(
            sql`DELETE FROM ${sql.identifier(tableInfo.tableName)}
                WHERE ${sql.identifier(tableInfo.timestampColumn)} < ${cutoffTimestamp}`,
          );
        } else {
          // Spec 016 B2 (H-02/FR-006): ação não implementada retorna falha
          // honesta com ZERO linhas — nunca sucesso falso com contagem cheia.
          logger.warn('Archive action NOT_IMPLEMENTED — nenhuma linha afetada', {
            context: { policyId: policy.id, dataType: policy.dataType },
          });
          return {
            policyId: policy.id,
            dataType: policy.dataType,
            rowsDeleted: 0,
            success: false,
            error: 'NOT_IMPLEMENTED',
            retryAttempts: attempt,
          };
        }

        return {
          policyId: policy.id,
          dataType: policy.dataType,
          rowsDeleted: rowsToDelete,
          success: true,
          retryAttempts: attempt,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        retryAttempt = attempt;

        if (this.isSqliteBusyError(error) && attempt < MAX_RETRY_ATTEMPTS) {
          const delay = this.getBackoffDelay(attempt);
          logger.warn('SQLite busy, retrying with backoff', {
            context: {
              policyId: policy.id,
              attempt: attempt + 1,
              maxAttempts: MAX_RETRY_ATTEMPTS + 1,
              delayMs: delay,
            },
          });
          await this.sleep(delay);
          continue;
        }

        // Non-retryable error or max retries exceeded
        break;
      }
    }

    return {
      policyId: policy.id,
      dataType: policy.dataType,
      rowsDeleted: 0,
      success: false,
      error: lastError?.message || 'Unknown error',
      retryAttempts: retryAttempt,
    };
  }

  /**
   * Create a job log entry
   */
  private async createJobLog(
    policyId: number,
    dbSizeBefore: number,
    runId: string,
  ): Promise<number> {
    const [log] = await db
      .insert(retentionJobLogs)
      .values({
        runId,
        policyId,
        dbSizeBeforeMb: dbSizeBefore,
        status: 'running',
      })
      .returning();
    return log.id;
  }

  /**
   * Update job log with results
   */
  private async updateJobLog(
    logId: number,
    result: CleanupResult,
    dbSizeAfter: number,
  ): Promise<void> {
    await db
      .update(retentionJobLogs)
      .set({
        executionCompletedAt: new Date(),
        status: result.success ? 'completed' : 'failed',
        rowsAffected: result.rowsDeleted,
        dbSizeAfterMb: dbSizeAfter,
        errorMessage: result.error || null,
        retryAttempt: result.retryAttempts,
      })
      .where(eq(retentionJobLogs.id, logId));
  }

  /**
   * Run cleanup for all active policies
   */
  async runCleanup(): Promise<JobExecutionResult> {
    if (this.isRunning) {
      throw new Error('Cleanup job is already running');
    }

    this.isRunning = true;
    const runId = randomUUID();
    const startedAt = new Date();
    const results: CleanupResult[] = [];
    const errors: string[] = [];

    try {
      // Get database size before cleanup
      const dbMetricsBefore = await retentionPolicyService.getDbSizeMetrics();
      const dbSizeBeforeMb = dbMetricsBefore.totalSizeMb;

      logger.info('Starting retention cleanup job', {
        context: { dbSizeBeforeMb },
      });

      // Get all active policies
      const policies = await retentionPolicyService.getAllPolicies();
      const activePolicies = policies.filter((p) => p.isActive);

      if (activePolicies.length === 0) {
        logger.info('No active retention policies found');
        const completedAt = new Date();
        return {
          startedAt,
          completedAt,
          runId,
          dbSizeBeforeMb,
          dbSizeAfterMb: dbSizeBeforeMb,
          policiesProcessed: 0,
          totalRowsDeleted: 0,
          results: [],
          errors: [],
        };
      }

      // Process each policy
      for (const policy of activePolicies) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - policy.ttlDays);
        // Spec 016 B2 (H-02/FR-005): semântica temporal correta por dialeto —
        // epoch (segundos) no SQLite, timestamp ISO no PostgreSQL.
        const cutoffTimestamp: number | string = isPostgres
          ? cutoffDate.toISOString()
          : Math.floor(cutoffDate.getTime() / 1000);

        // Create job log entry
        const logId = await this.createJobLog(policy.id, dbSizeBeforeMb, runId);

        // Execute cleanup
        const result = await this.executeWithRetry(policy, cutoffTimestamp);
        results.push(result);

        // Get current db size for this log
        const currentDbMetrics = await retentionPolicyService.getDbSizeMetrics();

        // Update job log
        await this.updateJobLog(logId, result, currentDbMetrics.totalSizeMb);

        if (!result.success) {
          errors.push(`Policy ${policy.id} (${policy.dataType}): ${result.error}`);
        }

        logger.info('Retention policy cleanup completed', {
          context: {
            policyId: policy.id,
            dataType: policy.dataType,
            rowsDeleted: result.rowsDeleted,
            success: result.success,
            retryAttempts: result.retryAttempts,
          },
        });
      }

      // Get database size after cleanup
      const dbMetricsAfter = await retentionPolicyService.getDbSizeMetrics();
      const dbSizeAfterMb = dbMetricsAfter.totalSizeMb;
      const completedAt = new Date();

      const totalRowsDeleted = results.reduce((sum, r) => sum + r.rowsDeleted, 0);

      // Log summary metric (PRD requirement)
      logger.info('PRD/TDD retention cleanup metric', {
        context: {
          dbSizeBeforeMb,
          dbSizeAfterMb,
          sizeReductionMb: Math.round((dbSizeBeforeMb - dbSizeAfterMb) * 100) / 100,
          totalRowsDeleted,
          policiesProcessed: activePolicies.length,
          durationMs: completedAt.getTime() - startedAt.getTime(),
        },
      });

      return {
        startedAt,
        completedAt,
        runId,
        dbSizeBeforeMb,
        dbSizeAfterMb,
        policiesProcessed: activePolicies.length,
        totalRowsDeleted,
        results,
        errors,
      };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Start the automatic scheduler
   */
  startScheduler(intervalHours: number = DEFAULT_SCHEDULE_HOURS): void {
    if (this.schedulerInterval) {
      logger.warn('Retention worker scheduler already running');
      return;
    }

    const intervalMs = intervalHours * 60 * 60 * 1000;

    logger.info('Starting retention cleanup scheduler', {
      context: { intervalHours, intervalMs },
    });

    // Run immediately on start, then on schedule
    this.runCleanup().catch((error) => {
      logger.error('Initial retention cleanup failed', {
        error: error instanceof Error ? error : undefined,
      });
    });

    this.schedulerInterval = setInterval(async () => {
      try {
        await this.runCleanup();
      } catch (error) {
        logger.error('Scheduled retention cleanup failed', {
          error: error instanceof Error ? error : undefined,
        });
      }
    }, intervalMs);
  }

  /**
   * Stop the automatic scheduler
   */
  stopScheduler(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
      logger.info('Retention cleanup scheduler stopped');
    }
  }

  /**
   * Check if scheduler is running
   */
  isSchedulerRunning(): boolean {
    return this.schedulerInterval !== null;
  }

  /**
   * Check if cleanup job is currently running
   */
  isJobRunning(): boolean {
    return this.isRunning;
  }
}

export const retentionWorker = new RetentionWorker();

/**
 * Initialize the retention worker (call from server startup)
 * Set RETENTION_WORKER_ENABLED=true to enable automatic scheduling
 */
export function initializeRetentionWorker(): void {
  const enabled = process.env.RETENTION_WORKER_ENABLED === 'true';
  const intervalHours = parseInt(process.env.RETENTION_WORKER_INTERVAL_HOURS || '24', 10);

  if (enabled) {
    logger.info('Initializing Retention Worker (Scheduled Mode)', {
      context: { intervalHours },
    });
    retentionWorker.startScheduler(intervalHours);
  } else {
    logger.info('Retention Worker initialized (Manual Mode Only)');
  }
}
