/**
 * Spec 015 B2 (auditoria H-10): outbox durável para regeneração de PDF.
 *
 * O job é persistido ANTES de a rota responder sucesso; o worker transiciona
 * pending → running → succeeded|failed; o startup recupera pendentes e
 * reconcilia `running` órfãos de um crash. Proporcional ao processo local:
 * SQLite via o mesmo padrão de `idempotency-schema` (append-only).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { dbHelper, isPostgres } from '../db';
import { logger } from '../utils/logger';

export type DocumentJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface DocumentJob {
  jobId: string;
  demandId: number;
  docType: string;
  targetFilepath: string;
  status: DocumentJobStatus;
  attempts: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

const CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS document_jobs (
    job_id TEXT PRIMARY KEY NOT NULL,
    demand_id INTEGER NOT NULL,
    doc_type TEXT NOT NULL,
    target_filepath TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS document_jobs_status_idx ON document_jobs(status)`,
  `CREATE INDEX IF NOT EXISTS document_jobs_demand_idx ON document_jobs(demand_id, doc_type)`,
] as const;

interface DocumentJobRow {
  job_id: string;
  demand_id: number;
  doc_type: string;
  target_filepath: string;
  status: string;
  attempts: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function toJob(row: DocumentJobRow): DocumentJob {
  return {
    jobId: row.job_id,
    demandId: row.demand_id,
    docType: row.doc_type,
    targetFilepath: row.target_filepath,
    status: row.status as DocumentJobStatus,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class DocumentJobsService {
  private ensured = false;

  async ensureSchema(): Promise<void> {
    if (this.ensured || isPostgres) return;
    for (const statement of CREATE_STATEMENTS) {
      await dbHelper.run(sql.raw(statement));
    }
    this.ensured = true;
  }

  /** Persiste o job ANTES do aceite HTTP (FR-005). Retorna o jobId. */
  async enqueue(demandId: number, docType: string, targetFilepath: string): Promise<string> {
    await this.ensureSchema();
    const jobId = randomUUID();
    const now = Date.now();
    await dbHelper.run(
      sql`INSERT INTO document_jobs (job_id, demand_id, doc_type, target_filepath, status, attempts, created_at, updated_at)
          VALUES (${jobId}, ${demandId}, ${docType}, ${targetFilepath}, 'pending', 0, ${now}, ${now})`,
    );
    return jobId;
  }

  async markRunning(jobId: string): Promise<void> {
    await this.transition(jobId, 'running', null, true);
  }

  async markSucceeded(jobId: string): Promise<void> {
    await this.transition(jobId, 'succeeded', null, false);
  }

  async markFailed(jobId: string, error: string): Promise<void> {
    await this.transition(jobId, 'failed', error.slice(0, 500), false);
  }

  private async transition(
    jobId: string,
    status: DocumentJobStatus,
    error: string | null,
    incrementAttempts: boolean,
  ): Promise<void> {
    await this.ensureSchema();
    const now = Date.now();
    await dbHelper.run(
      sql`UPDATE document_jobs
          SET status = ${status},
              error = ${error},
              attempts = attempts + ${incrementAttempts ? 1 : 0},
              updated_at = ${now}
          WHERE job_id = ${jobId}`,
    );
  }

  /** Último job para uma demanda+tipo — frescor do PDF visível na API (US2-AS3). */
  async latestFor(demandId: number, docType: string): Promise<DocumentJob | null> {
    await this.ensureSchema();
    const rows = await dbHelper.all<DocumentJobRow>(
      sql`SELECT * FROM document_jobs
          WHERE demand_id = ${demandId} AND doc_type = ${docType}
          ORDER BY created_at DESC LIMIT 1`,
    );
    return rows.length > 0 ? toJob(rows[0]) : null;
  }

  /**
   * Recuperação de startup (FR-007): retorna jobs `pending` para reprocessar e
   * reconcilia `running` órfãos — uma retomada extra; na reincidência, `failed`.
   */
  async recoverOnStartup(): Promise<DocumentJob[]> {
    await this.ensureSchema();

    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const orphans = await dbHelper.all<DocumentJobRow>(
      sql`SELECT * FROM document_jobs WHERE status = 'running' AND updated_at < ${fiveMinutesAgo}`,
    );
    for (const orphan of orphans) {
      if (orphan.attempts >= 2) {
        await this.markFailed(orphan.job_id, 'interrupted_by_restart');
        logger.error('Document job órfão marcado como failed após reinício', {
          context: { jobId: orphan.job_id, demandId: orphan.demand_id, docType: orphan.doc_type },
        });
      } else {
        await this.transition(orphan.job_id, 'pending', 'interrupted_by_restart_retrying', false);
      }
    }

    const pending = await dbHelper.all<DocumentJobRow>(
      sql`SELECT * FROM document_jobs WHERE status = 'pending' ORDER BY created_at ASC`,
    );
    if (pending.length > 0) {
      logger.info('Document jobs pendentes recuperados no startup', {
        context: { count: pending.length },
      });
    }
    return pending.map(toJob);
  }
}

export const documentJobsService = new DocumentJobsService();
