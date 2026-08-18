/**
 * Data Retention Policy Service
 *
 * Manages data retention policies and provides methods for:
 * - CRUD operations on retention policies
 * - Simulating impact of policies before applying
 * - Querying job execution logs
 * - Getting database size metrics
 *
 * PRD Reference: Políticas de Retenção de Dados e Modo Conversacional Interativo
 */

import { db, dbHelper, isPostgres } from '../db';
import { logger } from '../utils/logger';
import { eq, sql, desc } from 'drizzle-orm';
import {
  retentionPolicies,
  retentionJobLogs,
  type RetentionPolicy,
  type RetentionDataType,
  retentionDataTypeSchema,
} from '@shared/schema';
import type { RetentionJobLogDto } from '@shared/retention';
import { z } from 'zod';

// Validation schema for TTL (must be positive integer)
export const ttlValidationSchema = z.number().int().positive({
  message: 'TTL must be a positive integer (days)',
});

// Validation schema for creating/updating policies
export const createPolicySchema = z.object({
  dataType: retentionDataTypeSchema,
  ttlDays: ttlValidationSchema,
  action: z.enum(['archive', 'delete']).default('delete'),
  isActive: z.boolean().default(true),
  description: z.string().optional(),
});

export const updatePolicySchema = createPolicySchema.partial();

// Map data types to their corresponding table info for simulation
const DATA_TYPE_TABLE_MAP: Record<
  RetentionDataType,
  {
    tableName: string;
    timestampColumn: string;
    displayName: string;
  }
> = {
  chat_messages: {
    tableName: 'demands',
    timestampColumn: 'completed_at',
    displayName: 'Chat Messages (in completed demands)',
  },
  telemetry: {
    tableName: 'telemetry',
    timestampColumn: 'timestamp',
    displayName: 'Telemetry Records',
  },
  document_snapshots: {
    tableName: 'document_snapshots',
    timestampColumn: 'created_at',
    displayName: 'Document Snapshots',
  },
  approval_comments: {
    tableName: 'approval_comments',
    timestampColumn: 'created_at',
    displayName: 'Approval Comments',
  },
  document_lifecycle_events: {
    tableName: 'document_lifecycle_events',
    timestampColumn: 'created_at',
    displayName: 'Document Lifecycle Events',
  },
  human_feedback: {
    tableName: 'human_feedback',
    timestampColumn: 'created_at',
    displayName: 'Human Feedback',
  },
  feedback_refinamento: {
    tableName: 'feedback_refinamento',
    timestampColumn: 'criado_em',
    displayName: 'Refinement Feedback',
  },
  agent_interventions: {
    tableName: 'agent_interventions',
    timestampColumn: 'criado_em',
    displayName: 'Agent Interventions',
  },
  operation_attempts: {
    tableName: 'operation_attempts',
    timestampColumn: 'created_at',
    displayName: 'Operation Attempts',
  },
  model_routing_stage_runs: {
    tableName: 'model_routing_stage_runs',
    timestampColumn: 'created_at',
    displayName: 'Model Routing Stage Runs',
  },
  agent_decision_records: {
    tableName: 'agent_decision_records',
    timestampColumn: 'created_at',
    displayName: 'Agent Decision Records',
  },
  progressive_refinement_records: {
    tableName: 'progressive_refinement_records',
    timestampColumn: 'created_at',
    displayName: 'Progressive Refinement Records',
  },
};

/**
 * Auditoria 2026-08-01 (A08): `MIN(col)`/`MAX(col)` devolvem tipos diferentes
 * por dialeto — epoch em segundos no SQLite, `Date` no PostgreSQL. O código
 * fazia `new Date(valor * 1000)` incondicionalmente, o que no PG multiplica um
 * Date e produz `Invalid Date`.
 */
export function toIsoDate(value: number | string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    // String de data (alguns drivers devolvem timestamp como texto).
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return new Date(numeric * 1000).toISOString();
}

export interface SimulationResult {
  dataType: RetentionDataType;
  displayName: string;
  ttlDays: number;
  action: string;
  affectedRows: number;
  oldestRecordDate: string | null;
  newestAffectedDate: string | null;
}

export interface DbSizeMetrics {
  totalSizeMb: number;
  pageCount: number;
  pageSize: number;
  timestamp: string;
}

class RetentionPolicyService {
  /**
   * Get all retention policies
   */
  async getAllPolicies(): Promise<RetentionPolicy[]> {
    try {
      const policies = await db
        .select()
        .from(retentionPolicies)
        .orderBy(desc(retentionPolicies.createdAt));
      return policies;
    } catch (error) {
      logger.error('Error fetching retention policies', {
        error: error instanceof Error ? error : undefined,
      });
      throw error;
    }
  }

  /**
   * Get a single policy by ID
   */
  async getPolicyById(id: number): Promise<RetentionPolicy | null> {
    try {
      const [policy] = await db
        .select()
        .from(retentionPolicies)
        .where(eq(retentionPolicies.id, id));
      return policy || null;
    } catch (error) {
      logger.error('Error fetching retention policy', {
        error: error instanceof Error ? error : undefined,
        context: { policyId: id },
      });
      throw error;
    }
  }

  /**
   * Create a new retention policy
   */
  async createPolicy(data: z.infer<typeof createPolicySchema>): Promise<RetentionPolicy> {
    try {
      // Validate input
      const validated = createPolicySchema.parse(data);

      // Check if policy for this data type already exists
      const existing = await db
        .select()
        .from(retentionPolicies)
        .where(eq(retentionPolicies.dataType, validated.dataType));

      if (existing.length > 0) {
        throw new Error(`Policy for data type '${validated.dataType}' already exists`);
      }

      const [policy] = await db
        .insert(retentionPolicies)
        .values({
          dataType: validated.dataType,
          ttlDays: validated.ttlDays,
          action: validated.action,
          isActive: validated.isActive,
          description: validated.description,
        })
        .returning();

      logger.info('Retention policy created', {
        context: {
          policyId: policy.id,
          dataType: policy.dataType,
          ttlDays: policy.ttlDays,
        },
      });

      return policy;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Validation error: ${error.errors.map((e) => e.message).join(', ')}`);
      }
      logger.error('Error creating retention policy', {
        error: error instanceof Error ? error : undefined,
      });
      throw error;
    }
  }

  /**
   * Update an existing retention policy
   */
  async updatePolicy(
    id: number,
    data: z.infer<typeof updatePolicySchema>,
  ): Promise<RetentionPolicy | null> {
    try {
      // Validate input
      const validated = updatePolicySchema.parse(data);

      const [policy] = await db
        .update(retentionPolicies)
        .set({
          ...validated,
          updatedAt: new Date(),
        })
        .where(eq(retentionPolicies.id, id))
        .returning();

      if (policy) {
        logger.info('Retention policy updated', {
          context: {
            policyId: policy.id,
            dataType: policy.dataType,
            changes: validated,
          },
        });
      }

      return policy || null;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Validation error: ${error.errors.map((e) => e.message).join(', ')}`);
      }
      logger.error('Error updating retention policy', {
        error: error instanceof Error ? error : undefined,
        context: { policyId: id },
      });
      throw error;
    }
  }

  /**
   * Delete a retention policy
   */
  async deletePolicy(id: number): Promise<boolean> {
    try {
      const result = await db
        .delete(retentionPolicies)
        .where(eq(retentionPolicies.id, id))
        .returning();

      if (result.length > 0) {
        logger.info('Retention policy deleted', {
          context: { policyId: id },
        });
        return true;
      }
      return false;
    } catch (error) {
      logger.error('Error deleting retention policy', {
        error: error instanceof Error ? error : undefined,
        context: { policyId: id },
      });
      throw error;
    }
  }

  /**
   * Simulate the impact of a policy before saving
   * Returns the count of records that would be affected
   */
  async simulateImpact(dataType: RetentionDataType, ttlDays: number): Promise<SimulationResult> {
    try {
      const tableInfo = DATA_TYPE_TABLE_MAP[dataType];
      if (!tableInfo) {
        throw new Error(`Unknown data type: ${dataType}`);
      }

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - ttlDays);

      // Auditoria 2026-08-01 (A08): esta simulação quebrava DUAS vezes no
      // PostgreSQL. Primeiro usava `db.all`, que só existe no driver SQLite
      // (o wrapper agnóstico é `dbHelper.all`, já importado neste arquivo).
      // Segundo, comparava a coluna com epoch em segundos — e as 12 tabelas
      // do DATA_TYPE_TABLE_MAP são `timestamp` no schema PG, então a
      // comparação nem tipa. O corte passa a ser Date no PG (o driver
      // serializa para timestamp) e epoch no SQLite, onde as colunas são
      // integer.
      const cutoff: Date | number = isPostgres
        ? cutoffDate
        : Math.floor(cutoffDate.getTime() / 1000);

      // Count affected rows
      const countResult = (await dbHelper.all(
        sql`SELECT COUNT(*) as count FROM ${sql.identifier(tableInfo.tableName)}
            WHERE ${sql.identifier(tableInfo.timestampColumn)} < ${cutoff}`,
      )) as Array<{ count: number | string }>;

      // Get oldest record date
      const oldestResult = (await dbHelper.all(
        sql`SELECT MIN(${sql.identifier(tableInfo.timestampColumn)}) as oldest
            FROM ${sql.identifier(tableInfo.tableName)}`,
      )) as Array<{ oldest: number | string | Date | null }>;

      // Get newest affected record date
      const newestAffectedResult = (await dbHelper.all(
        sql`SELECT MAX(${sql.identifier(tableInfo.timestampColumn)}) as newest
            FROM ${sql.identifier(tableInfo.tableName)}
            WHERE ${sql.identifier(tableInfo.timestampColumn)} < ${cutoff}`,
      )) as Array<{ newest: number | string | Date | null }>;

      // PostgreSQL devolve COUNT(*) como string (bigint) — `|| 0` não protege
      // contra isso, só contra null.
      const affectedRows = Number(countResult[0]?.count ?? 0);
      const oldestTimestamp = oldestResult[0]?.oldest;
      const newestAffectedTimestamp = newestAffectedResult[0]?.newest;

      return {
        dataType,
        displayName: tableInfo.displayName,
        ttlDays,
        action: 'delete',
        affectedRows,
        oldestRecordDate: toIsoDate(oldestTimestamp),
        newestAffectedDate: toIsoDate(newestAffectedTimestamp),
      };
    } catch (error) {
      logger.error('Error simulating policy impact', {
        error: error instanceof Error ? error : undefined,
        context: { dataType, ttlDays },
      });
      throw error;
    }
  }

  /**
   * Simulate impact for all active policies
   */
  async simulateAllPolicies(): Promise<SimulationResult[]> {
    const policies = await this.getAllPolicies();
    const activePolicies = policies.filter((p) => p.isActive);

    const results: SimulationResult[] = [];
    for (const policy of activePolicies) {
      try {
        const result = await this.simulateImpact(policy.dataType, policy.ttlDays);
        result.action = policy.action;
        results.push(result);
      } catch (_error) {
        logger.warn('Error simulating policy', {
          context: { policyId: policy.id, dataType: policy.dataType },
        });
      }
    }

    return results;
  }

  /**
   * Get job execution logs
   */
  async getJobLogs(
    options: {
      policyId?: number;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<RetentionJobLogDto[]> {
    const { policyId, limit = 50, offset = 0 } = options;

    try {
      let query = db
        .select({
          id: retentionJobLogs.id,
          runId: retentionJobLogs.runId,
          policyId: retentionJobLogs.policyId,
          dataType: retentionPolicies.dataType,
          executionStartedAt: retentionJobLogs.executionStartedAt,
          executionCompletedAt: retentionJobLogs.executionCompletedAt,
          status: retentionJobLogs.status,
          rowsAffected: retentionJobLogs.rowsAffected,
          errorMessage: retentionJobLogs.errorMessage,
        })
        .from(retentionJobLogs)
        .leftJoin(retentionPolicies, eq(retentionJobLogs.policyId, retentionPolicies.id));

      if (policyId) {
        query = query.where(eq(retentionJobLogs.policyId, policyId)) as typeof query;
      }

      const logs = await query
        .orderBy(desc(retentionJobLogs.executionStartedAt))
        .limit(limit * 10)
        .offset(offset);

      return this.toRetentionJobLogDtos(logs).slice(0, limit);
    } catch (error) {
      logger.error('Error fetching job logs', {
        error: error instanceof Error ? error : undefined,
      });
      throw error;
    }
  }

  private toRetentionJobLogDtos(
    logs: Array<{
      id: number;
      runId: string | null;
      policyId: number;
      dataType: RetentionDataType | null;
      executionStartedAt: Date;
      executionCompletedAt: Date | null;
      status: 'running' | 'completed' | 'failed';
      rowsAffected: number;
      errorMessage: string | null;
    }>,
  ): RetentionJobLogDto[] {
    const groups = new Map<string, typeof logs>();

    for (const log of logs) {
      const key =
        log.runId ?? `legacy-${log.executionStartedAt.toISOString()}-${log.policyId}-${log.id}`;
      groups.set(key, [...(groups.get(key) ?? []), log]);
    }

    return Array.from(groups.values())
      .map((group) => {
        const startedAt = new Date(
          Math.min(...group.map((log) => log.executionStartedAt.getTime())),
        );
        const completedValues = group
          .map((log) => log.executionCompletedAt?.getTime())
          .filter((value): value is number => typeof value === 'number');
        const completedAt =
          completedValues.length === group.length ? new Date(Math.max(...completedValues)) : null;
        const status: RetentionJobLogDto['status'] = group.some((log) => log.status === 'failed')
          ? 'failed'
          : group.some((log) => log.status === 'running')
            ? 'running'
            : 'completed';
        const errors = group
          .map((log) => log.errorMessage)
          .filter((message): message is string => Boolean(message));

        return {
          id: Math.min(...group.map((log) => log.id)),
          status,
          dataTypesProcessed: Array.from(
            new Set(
              group
                .map((log) => log.dataType)
                .filter((value): value is RetentionDataType => Boolean(value)),
            ),
          ),
          totalRowsDeleted: group.reduce((sum, log) => sum + log.rowsAffected, 0),
          executionTimeMs: completedAt ? completedAt.getTime() - startedAt.getTime() : 0,
          errorMessage: errors.length > 0 ? errors.join('; ') : null,
          startedAt: startedAt.toISOString(),
          completedAt: completedAt?.toISOString() ?? null,
        };
      })
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }

  /**
   * Get database size metrics
   */
  async getDbSizeMetrics(): Promise<DbSizeMetrics> {
    try {
      // Spec 016 B2 (H-02/FR-005): tamanho por dialeto — PRAGMA é SQLite-only.
      if (isPostgres) {
        const sizeResult = (await dbHelper.all(
          sql`SELECT pg_database_size(current_database()) AS size_bytes`,
        )) as Array<{ size_bytes: number | string }>;
        const sizeBytes = Number(sizeResult[0]?.size_bytes ?? 0);
        return {
          totalSizeMb: Math.round((sizeBytes / (1024 * 1024)) * 100) / 100,
          pageCount: 0,
          pageSize: 0,
          timestamp: new Date().toISOString(),
        };
      }

      // A08: havia aqui um `SELECT ... FROM pragma_page_count(), pragma_page_size()`
      // cujo resultado era descartado — uma ida ao banco por nada. As duas
      // consultas abaixo é que produzem os valores usados.
      let pageCount = 0;
      let pageSize = 4096; // SQLite default

      const pageCountResult = (await dbHelper.all(sql`PRAGMA page_count`)) as Array<{
        page_count: number;
      }>;
      const pageSizeResult = (await dbHelper.all(sql`PRAGMA page_size`)) as Array<{
        page_size: number;
      }>;

      if (pageCountResult.length > 0) {
        pageCount = Object.values(pageCountResult[0])[0] as number;
      }
      if (pageSizeResult.length > 0) {
        pageSize = Object.values(pageSizeResult[0])[0] as number;
      }

      const totalSizeMb = (pageCount * pageSize) / (1024 * 1024);

      return {
        totalSizeMb: Math.round(totalSizeMb * 100) / 100,
        pageCount,
        pageSize,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error('Error fetching database size metrics', {
        error: error instanceof Error ? error : undefined,
      });
      throw error;
    }
  }

  /**
   * Get available data types with their display names
   */
  getAvailableDataTypes(): Array<{ value: RetentionDataType; label: string }> {
    return Object.entries(DATA_TYPE_TABLE_MAP).map(([key, info]) => ({
      value: key as RetentionDataType,
      label: info.displayName,
    }));
  }
}

export const retentionPolicyService = new RetentionPolicyService();
