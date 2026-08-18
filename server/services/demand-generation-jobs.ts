import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { dbHelper } from '../db';
import { logger } from '../utils/logger';

export type DemandGenerationJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface DemandGenerationJobConfig {
  agentIds: string[];
  maxRounds: number;
  refinementLevel: 1 | 2 | 3;
}

export interface DemandGenerationJob {
  id: string;
  demandId: number;
  config: DemandGenerationJobConfig;
  status: DemandGenerationJobStatus;
  attempts: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface DemandGenerationJobRow {
  id: string;
  demand_id: number;
  config: string;
  status: string;
  attempts: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS demand_generation_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    demand_id INTEGER NOT NULL,
    config TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS demand_generation_jobs_status_idx ON demand_generation_jobs(status)`,
  `CREATE INDEX IF NOT EXISTS demand_generation_jobs_demand_idx ON demand_generation_jobs(demand_id)`,
] as const;

function parseConfig(raw: string): DemandGenerationJobConfig {
  const parsed = JSON.parse(raw) as Partial<DemandGenerationJobConfig>;
  const refinementLevel =
    parsed.refinementLevel === 1 || parsed.refinementLevel === 2 || parsed.refinementLevel === 3
      ? parsed.refinementLevel
      : 3;

  return {
    agentIds: Array.isArray(parsed.agentIds) ? parsed.agentIds.filter(Boolean) : [],
    maxRounds: Number.isFinite(parsed.maxRounds) ? Number(parsed.maxRounds) : 3,
    refinementLevel,
  };
}

function toJob(row: DemandGenerationJobRow): DemandGenerationJob {
  return {
    id: row.id,
    demandId: row.demand_id,
    config: parseConfig(row.config),
    status: row.status as DemandGenerationJobStatus,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class DemandGenerationJobsService {
  private ensured = false;

  async ensureSchema(): Promise<void> {
    if (this.ensured) return;
    for (const statement of CREATE_STATEMENTS) {
      await dbHelper.run(sql.raw(statement));
    }
    this.ensured = true;
  }

  async enqueue(demandId: number, config: DemandGenerationJobConfig): Promise<string> {
    await this.ensureSchema();
    const id = randomUUID();
    const now = Date.now();

    await dbHelper.run(
      sql`INSERT INTO demand_generation_jobs
          (id, demand_id, config, status, attempts, created_at, updated_at)
          VALUES (${id}, ${demandId}, ${JSON.stringify(config)}, 'pending', 0, ${now}, ${now})`,
    );

    return id;
  }

  async markRunning(id: string): Promise<void> {
    await this.transition(id, 'running', null, true);
  }

  async markSucceeded(id: string): Promise<void> {
    await this.transition(id, 'succeeded', null, false);
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.transition(id, 'failed', error.slice(0, 500), false);
  }

  async listPending(): Promise<DemandGenerationJob[]> {
    await this.ensureSchema();
    const rows = await dbHelper.all<DemandGenerationJobRow>(
      sql`SELECT * FROM demand_generation_jobs
          WHERE status = 'pending'
          ORDER BY created_at ASC`,
    );
    return rows.map(toJob);
  }

  async listRunning(): Promise<DemandGenerationJob[]> {
    await this.ensureSchema();
    const rows = await dbHelper.all<DemandGenerationJobRow>(
      sql`SELECT * FROM demand_generation_jobs
          WHERE status = 'running'
          ORDER BY created_at ASC`,
    );
    return rows.map(toJob);
  }

  async findLatestByDemandId(demandId: number): Promise<DemandGenerationJob | null> {
    await this.ensureSchema();
    const rows = await dbHelper.all<DemandGenerationJobRow>(
      sql`SELECT * FROM demand_generation_jobs
          WHERE demand_id = ${demandId}
          ORDER BY created_at DESC
          LIMIT 1`,
    );
    return rows.length > 0 ? toJob(rows[0]) : null;
  }

  private async transition(
    id: string,
    status: DemandGenerationJobStatus,
    error: string | null,
    incrementAttempts: boolean,
  ): Promise<void> {
    await this.ensureSchema();
    const now = Date.now();

    await dbHelper.run(
      sql`UPDATE demand_generation_jobs
          SET status = ${status},
              error = ${error},
              attempts = attempts + ${incrementAttempts ? 1 : 0},
              updated_at = ${now}
          WHERE id = ${id}`,
    );
  }

  async recoverOnStartup(): Promise<DemandGenerationJob[]> {
    await this.ensureSchema();

    const running = await this.listRunning();
    for (const job of running) {
      // Após restart nenhum job herdado está realmente em execução neste
      // processo. Reenfileira como pending para reprocessamento seguro,
      // a menos que já tenha reincidido demais.
      if (job.attempts >= 2) {
        await this.markFailed(job.id, 'interrupted_by_restart');
        logger.error('Demand generation job marcado como failed após reinício repetido', {
          context: { jobId: job.id, demandId: job.demandId },
        });
      } else {
        await this.transition(job.id, 'pending', 'interrupted_by_restart_retrying', false);
        logger.info('Demand generation job running retornado para pending no startup', {
          context: { jobId: job.id, demandId: job.demandId, updatedAt: job.updatedAt },
        });
      }
    }

    const pending = await this.listPending();
    if (pending.length > 0) {
      logger.info('Demand generation jobs recuperados no startup', {
        context: { count: pending.length, queueHead: pending[0]?.demandId },
      });
    }

    return pending;
  }
}

export const demandGenerationJobsService = new DemandGenerationJobsService();
