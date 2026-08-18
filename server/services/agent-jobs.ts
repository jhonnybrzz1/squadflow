/**
 * Spec 10044 T2 — trilha de auditoria durável do disparo automático do agente
 * de código (Claude Code) após a conclusão de um speckit.
 *
 * Toda execução — sucesso, timeout, erro de spawn ou binário ausente — deixa um
 * registro em `agent_jobs` (regra 7.1: "todo disparo gera registro"). Segue o
 * mesmo padrão append-only de `document-jobs.ts`: SQLite via `dbHelper`, com
 * `ensureSchema()` idempotente e guard `isPostgres` (a feature é local-only).
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';

import { dbHelper, isPostgres } from '../db';
import { logger } from '../utils/logger';
import type { AgentJobStep } from '@shared/agent-job';

/**
 * Subconjunto do `dbHelper` de que este serviço precisa. Injetável para os
 * testes rodarem contra um SQLite in-memory hermético sem tocar no db global.
 */
export interface AgentJobsDbRunner {
  run(query: SQL): Promise<void> | void;
  all<T = Record<string, unknown>>(query: SQL): Promise<T[]> | T[];
}

let runner: AgentJobsDbRunner = dbHelper;

/**
 * Injeta um runner alternativo (in-memory) nos testes; null restaura o global.
 * Também reseta o cache de `ensureSchema` do singleton — o novo db começa vazio.
 */
export function __setAgentJobsRunnerForTests(custom: AgentJobsDbRunner | null): void {
  runner = custom ?? dbHelper;
  agentJobsService.resetSchemaCacheForTests();
}

/** Statements de criação — exportados para testes de schema contra `:memory:`. */
export const AGENT_JOBS_CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS agent_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    demand_id INTEGER NOT NULL,
    speckit_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    prompt_sent_hash TEXT NOT NULL,
    files_modified TEXT NOT NULL DEFAULT '[]',
    typecheck_passed INTEGER,
    api_cost_usd REAL,
    human_edits_count INTEGER NOT NULL DEFAULT 0,
    cancelled_at TEXT,
    error_message TEXT,
    steps TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS agent_jobs_demand_idx ON agent_jobs(demand_id)`,
  `CREATE INDEX IF NOT EXISTS agent_jobs_status_idx ON agent_jobs(status)`,
  // Índice em updated_at é criado APÓS as migrações aditivas, porque bancos
  // legados podem não ter a coluna ainda (spec 10148).
] as const;

const AGENT_JOBS_POST_MIGRATION_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS agent_jobs_updated_at_idx ON agent_jobs(updated_at)`,
] as const;

export type AgentJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

// Export legado para testes que validam a lista de statements.
export const AGENT_JOBS_MIGRATION_STATEMENTS = [] as const;

/**
 * Migração defensiva para bancos legados que podem não possuir `updated_at` ou
 * `steps`. SQLite não permite ALTER TABLE ADD COLUMN com default não-constante
 * (ex: unixepoch()), então recriamos a tabela preservando os dados.
 *
 * @param existingColumns nomes das colunas da tabela antiga (PRAGMA table_info)
 */
function migrateAgentJobsSchemaSqlite(existingColumns: string[]): string[] {
  const has = (name: string) => existingColumns.includes(name);

  const newTableSql = `CREATE TABLE agent_jobs_new (
    id TEXT PRIMARY KEY NOT NULL,
    demand_id INTEGER NOT NULL,
    speckit_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    prompt_sent_hash TEXT NOT NULL,
    files_modified TEXT NOT NULL DEFAULT '[]',
    typecheck_passed INTEGER,
    api_cost_usd REAL,
    human_edits_count INTEGER NOT NULL DEFAULT 0,
    cancelled_at TEXT,
    error_message TEXT,
    steps TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`;

  const columnExpr = (name: string, fallback: string, transform?: string) => {
    if (!has(name)) return fallback;
    return transform ? transform.replaceAll('{col}', name) : name;
  };

  const timestampExpr = (colName: string, fallback: string) => {
    if (!has(colName)) return fallback;
    return `COALESCE(CASE
      WHEN typeof(${colName}) = 'integer' THEN ${colName}
      WHEN ${colName} IS NULL THEN ${fallback}
      ELSE CAST(strftime('%s', ${colName}) AS INTEGER)
    END, ${fallback})`;
  };

  const createdAtFallback = has('created_at') ? timestampExpr('created_at', '0') : '0';
  const updatedAtExpr = has('updated_at')
    ? timestampExpr('updated_at', createdAtFallback)
    : createdAtFallback;

  const selectColumns = [
    'id',
    'demand_id',
    'speckit_path',
    columnExpr('status', "'running'", "COALESCE({col}, 'running')"),
    columnExpr('prompt_sent_hash', "''", "COALESCE({col}, '')"),
    columnExpr('files_modified', "'[]'", "COALESCE({col}, '[]')"),
    columnExpr('typecheck_passed', 'NULL'),
    columnExpr('api_cost_usd', 'NULL'),
    columnExpr('human_edits_count', '0', 'COALESCE({col}, 0)'),
    columnExpr('cancelled_at', 'NULL'),
    columnExpr('error_message', 'NULL'),
    columnExpr('steps', "'[]'", "COALESCE({col}, '[]')"),
    `${createdAtFallback} as created_at`,
    `${updatedAtExpr} as updated_at`,
  ];

  const insertColumns = [
    'id',
    'demand_id',
    'speckit_path',
    'status',
    'prompt_sent_hash',
    'files_modified',
    'typecheck_passed',
    'api_cost_usd',
    'human_edits_count',
    'cancelled_at',
    'error_message',
    'steps',
    'created_at',
    'updated_at',
  ];

  return [
    `DROP TABLE IF EXISTS agent_jobs_new`,
    newTableSql,
    `INSERT INTO agent_jobs_new (${insertColumns.join(', ')})
    SELECT ${selectColumns.join(', ')}
    FROM agent_jobs`,
    `DROP TABLE agent_jobs`,
    `ALTER TABLE agent_jobs_new RENAME TO agent_jobs`,
    `CREATE INDEX IF NOT EXISTS agent_jobs_demand_idx ON agent_jobs(demand_id)`,
    `CREATE INDEX IF NOT EXISTS agent_jobs_status_idx ON agent_jobs(status)`,
    `CREATE INDEX IF NOT EXISTS agent_jobs_updated_at_idx ON agent_jobs(updated_at)`,
  ];
}

function normalizeAgentJobStatus(status: string): AgentJobStatus {
  // Legacy records may have been stored as 'completed' before the contract
  // settled on 'succeeded'; normalize on read/write to keep the UI consistent.
  return status === 'completed' ? 'succeeded' : (status as AgentJobStatus);
}

export interface AgentJob {
  id: string;
  demandId: number;
  speckitPath: string;
  status: AgentJobStatus;
  promptSentHash: string;
  filesModified: string[];
  typecheckPassed: boolean | null;
  apiCostUsd: number | null;
  humanEditsCount: number;
  cancelledAt: string | null;
  errorMessage: string | null;
  steps: AgentJobStep[];
  createdAt: string;
  updatedAt: string;
}

interface AgentJobRow {
  id: string;
  demand_id: number;
  speckit_path: string;
  status: string;
  prompt_sent_hash: string;
  files_modified: string;
  typecheck_passed: number | null;
  api_cost_usd: number | null;
  human_edits_count: number;
  cancelled_at: string | null;
  error_message: string | null;
  steps: string | null;
  created_at: string;
  updated_at: string;
}

function toJob(row: AgentJobRow): AgentJob {
  let filesModified: string[] = [];
  try {
    const parsed = JSON.parse(row.files_modified);
    if (Array.isArray(parsed)) filesModified = parsed.map(String);
  } catch {
    // registro tolerante: um files_modified corrompido não deve quebrar a leitura.
  }
  let steps: AgentJobStep[] = [];
  try {
    const parsed = JSON.parse(row.steps ?? '[]');
    if (Array.isArray(parsed)) steps = parsed as AgentJobStep[];
  } catch {
    // steps corrompido não deve quebrar a leitura do job.
  }
  return {
    id: row.id,
    demandId: row.demand_id,
    speckitPath: row.speckit_path,
    status: normalizeAgentJobStatus(row.status),
    promptSentHash: row.prompt_sent_hash,
    filesModified,
    typecheckPassed: row.typecheck_passed === null ? null : row.typecheck_passed === 1,
    apiCostUsd: row.api_cost_usd,
    humanEditsCount: row.human_edits_count,
    cancelledAt: row.cancelled_at,
    errorMessage: row.error_message,
    steps,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Campos gravados no fechamento do job, após a execução do agente. */
export interface AgentJobCompletion {
  status: AgentJobStatus;
  filesModified?: string[];
  typecheckPassed?: boolean | null;
  apiCostUsd?: number | null;
  cancelledAt?: string | null;
  errorMessage?: string | null;
  steps?: AgentJobStep[];
}

export class AgentJobsService {
  private ensured = false;

  /** Testes: força re-execução de `ensureSchema` ao trocar o db injetado. */
  resetSchemaCacheForTests(): void {
    this.ensured = false;
  }

  async ensureSchema(): Promise<void> {
    if (this.ensured || isPostgres) return;

    // Detecta banco legado sem a coluna updated_at e roda migração de recriação
    // antes de qualquer outra coisa. SQLite < 3.35.0 não suporta DROP COLUMN;
    // recriar a tabela é a forma portátil de adicionar colunas NOT NULL com
    // default não-constante (ex: unixepoch()).
    const columns = await runner.all<{ name: string }>(sql.raw("PRAGMA table_info('agent_jobs')"));
    const needsMigration = columns.length > 0 && !columns.some((c) => c.name === 'updated_at');
    if (needsMigration) {
      const existingColumnNames = columns.map((c) => c.name);
      for (const statement of migrateAgentJobsSchemaSqlite(existingColumnNames)) {
        await runner.run(sql.raw(statement));
      }
      this.ensured = true;
      return;
    }

    for (const statement of AGENT_JOBS_CREATE_STATEMENTS) {
      await runner.run(sql.raw(statement));
    }
    // Índice que depende da coluna updated_at.
    for (const statement of AGENT_JOBS_POST_MIGRATION_STATEMENTS) {
      await runner.run(sql.raw(statement));
    }
    this.ensured = true;
  }

  /**
   * Abre o job em `running` no momento do disparo (registro nasce antes da
   * execução para nunca perdermos auditoria se o processo travar). Retorna o id.
   */
  async open(demandId: number, speckitPath: string, promptSentHash: string): Promise<string> {
    await this.ensureSchema();
    const id = randomUUID();
    const nowSeconds = Math.floor(Date.now() / 1000);
    await runner.run(
      sql`INSERT INTO agent_jobs (id, demand_id, speckit_path, status, prompt_sent_hash, created_at, updated_at)
          VALUES (${id}, ${demandId}, ${speckitPath}, 'running', ${promptSentHash}, ${nowSeconds}, ${nowSeconds})`,
    );
    return id;
  }

  /** Fecha o job com o resultado da execução (sucesso ou falha). Idempotente por id. */
  async complete(id: string, completion: AgentJobCompletion): Promise<void> {
    await this.ensureSchema();
    const filesModified = JSON.stringify(completion.filesModified ?? []);
    const typecheckPassed =
      completion.typecheckPassed === undefined || completion.typecheckPassed === null
        ? null
        : completion.typecheckPassed
          ? 1
          : 0;
    const steps = JSON.stringify(completion.steps ?? []);
    const status = normalizeAgentJobStatus(completion.status);
    const nowSeconds = Math.floor(Date.now() / 1000);
    await runner.run(
      sql`UPDATE agent_jobs
          SET status = ${status},
              files_modified = ${filesModified},
              typecheck_passed = ${typecheckPassed},
              api_cost_usd = ${completion.apiCostUsd ?? null},
              cancelled_at = ${completion.cancelledAt ?? null},
              error_message = ${completion.errorMessage ? completion.errorMessage.slice(0, 1000) : null},
              steps = ${steps},
              updated_at = ${nowSeconds}
          WHERE id = ${id}`,
    );
  }

  async findById(id: string): Promise<AgentJob | null> {
    await this.ensureSchema();
    const rows = await runner.all<AgentJobRow>(sql`SELECT * FROM agent_jobs WHERE id = ${id}`);
    return rows.length > 0 ? toJob(rows[0]) : null;
  }

  /** Registros de uma demanda, mais recente primeiro — para consulta de auditoria. */
  async listForDemand(demandId: number): Promise<AgentJob[]> {
    await this.ensureSchema();
    const rows = await runner.all<AgentJobRow>(
      sql`SELECT * FROM agent_jobs WHERE demand_id = ${demandId} ORDER BY created_at DESC`,
    );
    return rows.map(toJob);
  }

  /**
   * Spec 10148 — recoverOnStartup: marca jobs `running` órfãos (sem heartbeat
   * por mais de 5 minutos) como `failed`. `agent_jobs` é trilha de auditoria e
   * não tem o prompt real, então `pending` não é reprocessável pelo worker
   * atual (code_agent_job_queue é a fila de trabalho). O filtro temporal evita
   * marcar jobs genuinamente em execução durante um restart rápido.
   */
  async recoverOnStartup(): Promise<AgentJob[]> {
    await this.ensureSchema();

    const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 5 * 60;
    const orphans = await runner.all<AgentJobRow>(
      sql`SELECT * FROM agent_jobs WHERE status = 'running' AND updated_at < ${fiveMinutesAgo}`,
    );
    if (orphans.length > 0) {
      const ids = orphans.map((row) => row.id);
      const nowSeconds = Math.floor(Date.now() / 1000);
      await runner.run(
        sql`UPDATE agent_jobs
            SET status = 'failed',
                error_message = 'interrupted_by_restart',
                updated_at = ${nowSeconds}
            WHERE id IN (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )})`,
      );
      logger.info('[RECOVERY] agent_jobs: marking orphaned running jobs as failed', {
        context: { count: orphans.length, ids, threshold: '5 minutes' },
      });
    }

    const pending = await runner.all<AgentJobRow>(
      sql`SELECT * FROM agent_jobs WHERE status = 'pending' ORDER BY created_at ASC`,
    );
    if (pending.length > 0) {
      logger.warn('agent_jobs: pending jobs are audit-only and not reprocessed by current worker', {
        context: { count: pending.length },
      });
    }
    return pending.map(toJob);
  }
}

export const agentJobsService = new AgentJobsService();
