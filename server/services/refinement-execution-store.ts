/**
 * Demanda 10025 — persistência das execuções de refinamento
 * (`refinement_executions`): auditoria de fallback, score, tokens, tempo,
 * fases e artefato; alimenta `GET /api/refinement/history`.
 */

import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  refinementExecutions,
  type InsertRefinementExecution,
  type RefinementExecution,
  type RefinementExecutionMethod,
} from '@shared/schema';
import { logger } from '../utils/logger';

export interface RefinementHistoryQuery {
  method?: RefinementExecutionMethod;
  limit?: number;
  offset?: number;
}

export interface RefinementHistoryResult {
  executions: Array<{
    id: string;
    demandId: number;
    method: RefinementExecutionMethod;
    fallbackUsed: boolean;
    adapterFallback: boolean;
    consensusScore: number | null;
    tokensUsed: number;
    executionTimeMs: number;
    error: string | null;
    createdAt: string;
  }>;
  total: number;
}

export class RefinementExecutionStore {
  async save(record: InsertRefinementExecution): Promise<void> {
    await db.insert(refinementExecutions).values(record);
    logger.debug('refinement_executions: execução persistida', {
      context: { id: record.id, demandId: record.demandId, method: record.method },
    });
  }

  async list(query: RefinementHistoryQuery = {}): Promise<RefinementHistoryResult> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = Math.max(query.offset ?? 0, 0);

    const where = query.method ? eq(refinementExecutions.method, query.method) : undefined;

    const base = db.select().from(refinementExecutions);
    const rows: RefinementExecution[] = await (where ? base.where(where) : base)
      .orderBy(desc(refinementExecutions.createdAt))
      .limit(limit)
      .offset(offset);

    const countBase = db.select({ count: sql<number>`count(*)` }).from(refinementExecutions);
    const [{ count }] = await (where ? countBase.where(where) : countBase);

    return {
      executions: rows.map((row) => ({
        id: row.id,
        demandId: row.demandId,
        method: row.method,
        fallbackUsed: row.fallbackUsed,
        adapterFallback: row.adapterFallback,
        consensusScore: row.consensusScore,
        tokensUsed: row.tokensUsed,
        executionTimeMs: row.executionTimeMs,
        error: row.error,
        createdAt:
          row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      })),
      total: Number(count),
    };
  }
}

export const refinementExecutionStore = new RefinementExecutionStore();
