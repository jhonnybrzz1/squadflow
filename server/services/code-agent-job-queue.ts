/**
 * Bug 3 (fila in-memory perde jobs no restart) — fila DURÁVEL do agente de código.
 *
 * O `code-agent-worker` mantinha os jobs apenas num array em memória: um restart
 * do servidor entre o enfileiramento e a conclusão perdia o trabalho e não
 * deixava rastro. Aqui o job é persistido em SQLite ANTES de rodar, transiciona
 * pending → processing → done|failed, e o startup recupera pending/processing
 * (um crash durante o processamento deixa a linha em `processing`, que é
 * retomada). Mesmo padrão append-only de `document-jobs.ts` / `agent-jobs.ts`.
 *
 * Durabilidade (dependência do PRD): o banco já roda em WAL (server/db.ts). As
 * escritas críticas da fila (enqueue e transição para `processing`) são feitas
 * sob `PRAGMA synchronous = FULL` — só elas — para que um crash logo após não
 * perca o job; o restante do app segue em `synchronous = NORMAL`.
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';

import { dbHelper, isPostgres } from '../db';
import { logger } from '../utils/logger';

export type CodeAgentQueueStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface CodeAgentQueueRow {
  id: string;
  demandId: number;
  speckitPath: string;
  prompt: string;
  cwd: string | null;
  status: CodeAgentQueueStatus;
  error: string | null;
  /** PID do processo-filho do agente (claude) enquanto `processing`. */
  workerPid: number | null;
  /** Número de tentativas de execução (guardrail contra re-execução parcial). */
  attempts: number;
  /** Timestamp do último heartbeat enquanto `processing`. */
  lastHeartbeatAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Dados necessários para reconstruir um job na fila em memória. */
export interface CodeAgentQueueInput {
  demandId: number;
  speckitPath: string;
  prompt: string;
  cwd?: string;
}

/**
 * Subconjunto do `dbHelper` de que este serviço precisa. Injetável para os
 * testes rodarem contra um SQLite in-memory hermético sem tocar no db global.
 */
export interface CodeAgentQueueDbRunner {
  run(query: SQL): Promise<void> | void;
  all<T = Record<string, unknown>>(query: SQL): Promise<T[]> | T[];
}

let runner: CodeAgentQueueDbRunner = dbHelper;

/**
 * Injeta um runner alternativo (in-memory) nos testes; null restaura o global.
 * Também reseta o cache de `ensureSchema` do singleton — o novo db começa vazio.
 */
export function __setCodeAgentQueueRunnerForTests(custom: CodeAgentQueueDbRunner | null): void {
  runner = custom ?? dbHelper;
  codeAgentJobQueueService.resetSchemaCacheForTests();
}

export const CODE_AGENT_QUEUE_CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS code_agent_job_queue (
    id TEXT PRIMARY KEY NOT NULL,
    demand_id INTEGER NOT NULL,
    speckit_path TEXT NOT NULL,
    prompt TEXT NOT NULL,
    cwd TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    worker_pid INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_heartbeat_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS code_agent_job_queue_status_idx ON code_agent_job_queue(status)`,
] as const;

/**
 * ALTER defensivo para bancos criados antes da coluna `attempts`.
 * Roda em try/catch: se a coluna já existe, o SQLite lança e ignoramos.
 */
const CODE_AGENT_QUEUE_MIGRATION_STATEMENTS = [
  `ALTER TABLE code_agent_job_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`,
] as const;

// ALTER defensivo: bancos criados antes da coluna `worker_pid` (guarda de
// recuperação por PID). SQLite não tem "ADD COLUMN IF NOT EXISTS"; um erro de
// coluna duplicada é engolido. Mesmo padrão do `agent_jobs.steps`.
const CODE_AGENT_QUEUE_ALTER_STATEMENTS = [
  `ALTER TABLE code_agent_job_queue ADD COLUMN worker_pid INTEGER`,
] as const;

// ALTER defensivo: bancos criados antes da coluna `last_heartbeat_at`.
const CODE_AGENT_QUEUE_HEARTBEAT_MIGRATION_STATEMENTS = [
  `ALTER TABLE code_agent_job_queue ADD COLUMN last_heartbeat_at INTEGER`,
] as const;

interface QueueDbRow {
  id: string;
  demand_id: number;
  speckit_path: string;
  prompt: string;
  cwd: string | null;
  status: string;
  error: string | null;
  worker_pid: number | null;
  attempts: number;
  last_heartbeat_at: number | null;
  created_at: number;
  updated_at: number;
}

function toRow(row: QueueDbRow): CodeAgentQueueRow {
  return {
    id: row.id,
    demandId: row.demand_id,
    speckitPath: row.speckit_path,
    prompt: row.prompt,
    cwd: row.cwd,
    status: row.status as CodeAgentQueueStatus,
    error: row.error,
    workerPid: row.worker_pid ?? null,
    attempts: row.attempts ?? 0,
    lastHeartbeatAt: row.last_heartbeat_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * `true` se um processo com este PID ainda existe. `kill(pid, 0)` não envia
 * sinal — só testa a existência: sucesso ou EPERM (existe, sem permissão) =
 * vivo; ESRCH = morto. Risco de reuso de PID é baixo na janela de restart e o
 * lado errado seguro é "vivo" (não recupera → sem duplicação).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class CodeAgentJobQueueService {
  private ensured = false;

  resetSchemaCacheForTests(): void {
    this.ensured = false;
  }

  async ensureSchema(): Promise<void> {
    if (this.ensured) return;
    for (const statement of CODE_AGENT_QUEUE_CREATE_STATEMENTS) {
      await runner.run(sql.raw(statement));
    }
    for (const statement of CODE_AGENT_QUEUE_MIGRATION_STATEMENTS) {
      try {
        await runner.run(sql.raw(statement));
      } catch (_) {
        /* coluna já existe — ALTER idempotente */
      }
    }
    for (const statement of CODE_AGENT_QUEUE_ALTER_STATEMENTS) {
      try {
        await runner.run(sql.raw(statement));
      } catch (_) {
        /* coluna já existe — ALTER idempotente */
      }
    }
    for (const statement of CODE_AGENT_QUEUE_HEARTBEAT_MIGRATION_STATEMENTS) {
      try {
        await runner.run(sql.raw(statement));
      } catch (_) {
        /* coluna já existe — ALTER idempotente */
      }
    }
    try {
      await runner.run(
        sql.raw(
          'CREATE INDEX IF NOT EXISTS code_agent_job_queue_heartbeat_idx ON code_agent_job_queue(status, last_heartbeat_at)',
        ),
      );
    } catch (_) {
      /* índice pode já existir ou coluna ausente em bancos muito antigos — segue */
    }
    this.ensured = true;
  }

  /**
   * Roda `fn` sob `PRAGMA synchronous = FULL` e restaura `NORMAL` no final —
   * durabilidade máxima só para a escrita crítica. No-op em Postgres (PRAGMA é
   * específico do SQLite). better-sqlite3 é síncrono, então não há intercalação
   * de outras escritas entre o toggle e o reset dentro deste processo.
   */
  private async withFullSync<T>(fn: () => Promise<T>): Promise<T> {
    if (isPostgres) return fn();
    try {
      await runner.run(sql.raw('PRAGMA synchronous = FULL'));
    } catch (_) {
      /* pragma indisponível (ex.: :memory:) — segue sem durabilidade extra */
    }
    try {
      return await fn();
    } finally {
      try {
        await runner.run(sql.raw('PRAGMA synchronous = NORMAL'));
      } catch (_) {
        /* swallow */
      }
    }
  }

  /** Persiste o job como `pending` ANTES de rodar. Retorna o id. */
  async enqueue(input: CodeAgentQueueInput): Promise<string> {
    await this.ensureSchema();
    const id = randomUUID();
    const now = Date.now();
    await this.withFullSync(() =>
      Promise.resolve(
        runner.run(
          sql`INSERT INTO code_agent_job_queue (id, demand_id, speckit_path, prompt, cwd, status, created_at, updated_at)
              VALUES (${id}, ${input.demandId}, ${input.speckitPath}, ${input.prompt}, ${input.cwd ?? null}, 'pending', ${now}, ${now})`,
        ),
      ),
    );
    return id;
  }

  async markProcessing(id: string): Promise<void> {
    await this.withFullSync(async () => {
      await this.transition(id, 'processing', null);
      await this.recordHeartbeat(id);
    });
  }

  async recordHeartbeat(id: string): Promise<void> {
    await this.ensureSchema();
    const now = Date.now();
    await Promise.resolve(
      runner.run(
        sql`UPDATE code_agent_job_queue
            SET last_heartbeat_at = ${now}, updated_at = ${now}
            WHERE id = ${id} AND status = 'processing'`,
      ),
    );
  }

  /**
   * Spec 10114: timeout/heartbeat para jobs em 'processing'.
   * Jobs sem heartbeat dentro de `thresholdMs` são marcados como failed.
   * Retorna os ids afetados.
   */
  async timeoutStaleProcessingJobs(thresholdMs = 60_000): Promise<string[]> {
    await this.ensureSchema();
    const now = Date.now();
    const rows = await Promise.resolve(
      runner.all<QueueDbRow>(
        sql`SELECT * FROM code_agent_job_queue
            WHERE status = 'processing'
              AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ${now - thresholdMs})`,
      ),
    );
    const ids: string[] = [];
    for (const row of rows) {
      // Guarda de PID: se o processo ainda está vivo, não aplicamos timeout.
      if (row.worker_pid != null && isPidAlive(row.worker_pid)) continue;
      await Promise.resolve(
        runner.run(
          sql`UPDATE code_agent_job_queue
              SET status = 'failed',
                  error = 'heartbeat_timeout',
                  updated_at = ${now}
              WHERE id = ${row.id}`,
        ),
      );
      ids.push(row.id);
    }
    if (ids.length > 0) {
      logger.warn('[heartbeat] Jobs processing marcados como failed por falta de heartbeat', {
        context: { count: ids.length, ids },
      });
    }
    return ids;
  }

  /**
   * Persiste o PID do processo-filho do agente enquanto o job roda. Consumido
   * por `recoverOnStartup` para não re-executar um job cujo processo ainda vive.
   */
  async recordWorkerPid(id: string, pid: number): Promise<void> {
    await this.ensureSchema();
    await Promise.resolve(
      runner.run(
        sql`UPDATE code_agent_job_queue
            SET worker_pid = ${pid}, updated_at = ${Date.now()}
            WHERE id = ${id} AND status = 'processing'`,
      ),
    );
  }

  async markDone(id: string): Promise<void> {
    await this.transition(id, 'done', null);
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.transition(id, 'failed', error.slice(0, 500));
  }

  private async transition(
    id: string,
    status: CodeAgentQueueStatus,
    error: string | null,
  ): Promise<void> {
    await this.ensureSchema();
    const now = Date.now();
    await Promise.resolve(
      runner.run(
        sql`UPDATE code_agent_job_queue
            SET status = ${status},
                error = ${error},
                worker_pid = CASE WHEN ${status} = 'processing' THEN worker_pid ELSE NULL END,
                attempts = attempts + CASE WHEN ${status} = 'processing' THEN 1 ELSE 0 END,
                updated_at = ${now}
            WHERE id = ${id}`,
      ),
    );
  }

  /**
   * Recuperação de startup: jobs em `pending` (nunca começaram) e `processing`
   * (interrompidos por um crash/restart) voltam a `pending` e são retornados
   * para o worker reprocessar em ordem de criação. Cumpre o AC do Bug 3:
   * "jobs em estado 'processing' permanecem intactos no SQLite e são recuperados".
   *
   * GUARDA DE PID (correção do double-run): um `processing` cujo `worker_pid`
   * AINDA está vivo NÃO é recuperado — o processo-filho detached sobreviveu ao
   * restart (típico do tsx-watch em dev) e segue rodando; re-enfileirar criaria
   * um segundo agente concorrente na mesma árvore. Esses jobs são marcados
   * `failed` (abandonados: o novo worker não tem handle do órfão) para nunca
   * mais serem recuperados. Só recuperamos `processing` com PID morto/ausente.
   */
  async recoverOnStartup(): Promise<CodeAgentQueueRow[]> {
    await this.ensureSchema();
    const rows = await Promise.resolve(
      runner.all<QueueDbRow>(
        sql`SELECT * FROM code_agent_job_queue
            WHERE status IN ('pending', 'processing')
            ORDER BY created_at ASC`,
      ),
    );

    const alive = rows.filter(
      (row) => row.status === 'processing' && row.worker_pid != null && isPidAlive(row.worker_pid),
    );
    const recoverable = rows.filter((row) => !alive.includes(row));

    const now = Date.now();
    for (const row of alive) {
      await Promise.resolve(
        runner.run(
          sql`UPDATE code_agent_job_queue
              SET status = 'failed',
                  error = 'processo original (pid ' || ${row.worker_pid} || ') sobreviveu ao restart; não re-executado para evitar execução concorrente',
                  updated_at = ${now}
              WHERE id = ${row.id}`,
        ),
      );
    }
    if (alive.length > 0) {
      logger.warn('Code agent jobs NÃO recuperados (processo original ainda vivo)', {
        context: { count: alive.length, ids: alive.map((r) => r.id) },
      });
    }

    logger.info('[recovery] Iniciando recuperação de code agent jobs', {
      context: { total: rows.length },
    });

    const toRetry: QueueDbRow[] = [];
    const toFail: QueueDbRow[] = [];

    for (const row of recoverable) {
      if (row.status !== 'processing') continue;
      if ((row.attempts ?? 0) >= 3) {
        toFail.push(row);
      } else {
        toRetry.push(row);
      }
    }

    for (const row of toFail) {
      await Promise.resolve(
        runner.run(
          sql`UPDATE code_agent_job_queue
              SET status = 'failed',
                  error = 'max_attempts_exceeded_after_restart',
                  updated_at = ${now}
              WHERE id = ${row.id}`,
        ),
      );
    }

    for (const row of toRetry) {
      await Promise.resolve(
        runner.run(
          sql`UPDATE code_agent_job_queue
              SET status = 'pending',
                  attempts = attempts + 1,
                  updated_at = ${now}
              WHERE id = ${row.id}`,
        ),
      );
    }

    logger.info('[recovery] Recuperação de code agent jobs concluída', {
      context: {
        resetToPending: toRetry.length,
        markedFailed: toFail.length,
        preservedAlive: alive.length,
      },
    });

    return [...toRetry, ...rows.filter((r) => r.status === 'pending')].map(toRow);
  }
}

export const codeAgentJobQueueService = new CodeAgentJobQueueService();
