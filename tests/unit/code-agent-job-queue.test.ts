import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '@shared/schema';
import {
  CODE_AGENT_QUEUE_CREATE_STATEMENTS,
  CodeAgentJobQueueService,
  __setCodeAgentQueueRunnerForTests,
  type CodeAgentQueueDbRunner,
} from '../../server/services/code-agent-job-queue';

/**
 * Bug 3: a fila do agente de código sobrevive a um restart. Estes testes rodam
 * contra um SQLite REAL em memória (não um mock de linhas) para provar o schema e
 * a semântica de recuperação de verdade — ver memória "Testes mockam o banco".
 */
function makeRunner(sqlite: Database.Database): CodeAgentQueueDbRunner {
  const db = drizzle(sqlite, { schema });
  return {
    run: (q) => db.run(q),
    all: <T>(q: ReturnType<typeof sql>) => db.all(q) as T[],
  };
}

describe('CodeAgentJobQueueService — fila durável (Bug 3)', () => {
  let active: Database.Database | null = null;

  afterEach(() => {
    __setCodeAgentQueueRunnerForTests(null);
    active?.close();
    active = null;
  });

  function freshService(): CodeAgentJobQueueService {
    const sqlite = new Database(':memory:');
    active = sqlite;
    __setCodeAgentQueueRunnerForTests(makeRunner(sqlite));
    return new CodeAgentJobQueueService();
  }

  it('cria a tabela idempotentemente com as colunas da fila', async () => {
    const sqlite = new Database(':memory:');
    active = sqlite;
    for (const s of CODE_AGENT_QUEUE_CREATE_STATEMENTS) sqlite.exec(s);
    for (const s of CODE_AGENT_QUEUE_CREATE_STATEMENTS) sqlite.exec(s); // idempotente

    const cols = (
      sqlite.prepare("PRAGMA table_info('code_agent_job_queue')").all() as Array<{ name: string }>
    ).map((c) => c.name);

    for (const expected of [
      'id',
      'demand_id',
      'speckit_path',
      'prompt',
      'cwd',
      'status',
      'error',
      'worker_pid',
      'attempts',
      'created_at',
      'updated_at',
    ]) {
      expect(cols).toContain(expected);
    }
  });

  it('enqueue persiste o job como pending antes de rodar', async () => {
    const service = freshService();
    const id = await service.enqueue({
      demandId: 42,
      speckitPath: 'specs/42/spec.md',
      prompt: 'go',
    });
    expect(id).toMatch(/[0-9a-f-]{36}/);

    const rows = active!
      .prepare('SELECT status, demand_id FROM code_agent_job_queue WHERE id = ?')
      .all(id) as Array<{ status: string; demand_id: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].demand_id).toBe(42);
  });

  it('transições pending → processing → done atualizam o status', async () => {
    const service = freshService();
    const id = await service.enqueue({ demandId: 1, speckitPath: 's', prompt: 'p' });
    await service.markProcessing(id);
    expect(status(id)).toBe('processing');
    await service.markDone(id);
    expect(status(id)).toBe('done');
  });

  it('markFailed grava o erro (truncado) e o status failed', async () => {
    const service = freshService();
    const id = await service.enqueue({ demandId: 1, speckitPath: 's', prompt: 'p' });
    await service.markFailed(id, 'x'.repeat(1000));
    const row = active!
      .prepare('SELECT status, error FROM code_agent_job_queue WHERE id = ?')
      .get(id) as { status: string; error: string };
    expect(row.status).toBe('failed');
    expect(row.error).toHaveLength(500);
  });

  it('AC Bug 3: um job em processing sobrevive ao restart e é recuperado', async () => {
    // Simula o crash: enqueue + markProcessing, depois o serviço "reinicia"
    // (nova instância) apontando para o MESMO SQLite.
    const first = freshService();
    const idProcessing = await first.enqueue({
      demandId: 7,
      speckitPath: 'specs/7/spec.md',
      prompt: 'crash-me',
    });
    await first.markProcessing(idProcessing);
    const idPending = await first.enqueue({
      demandId: 8,
      speckitPath: 'specs/8/spec.md',
      prompt: 'wait',
    });

    // "Restart": o banco continua o mesmo; só a instância do serviço é nova.
    const afterRestart = new CodeAgentJobQueueService();
    const recovered = await afterRestart.recoverOnStartup();

    const recoveredIds = recovered.map((r) => r.id);
    expect(recoveredIds).toContain(idProcessing);
    expect(recoveredIds).toContain(idPending);
    // O job interrompido volta para pending, pronto para reprocessar.
    expect(status(idProcessing)).toBe('pending');
  });

  it('não recupera um processing cujo filho ainda está vivo', async () => {
    const service = freshService();
    const id = await service.enqueue({ demandId: 9, speckitPath: 's', prompt: 'p' });
    await service.markProcessing(id);
    await service.recordWorkerPid(id, process.pid);

    const recovered = await new CodeAgentJobQueueService().recoverOnStartup();

    expect(recovered).toHaveLength(0);
    const row = active!
      .prepare('SELECT status, error FROM code_agent_job_queue WHERE id = ?')
      .get(id) as { status: string; error: string };
    expect(row.status).toBe('failed');
    expect(row.error).toContain(`pid ${process.pid}`);
  });

  it('migra banco existente sem worker_pid antes de recuperar jobs', async () => {
    const sqlite = new Database(':memory:');
    active = sqlite;
    sqlite.exec(`CREATE TABLE code_agent_job_queue (
      id TEXT PRIMARY KEY NOT NULL, demand_id INTEGER NOT NULL, speckit_path TEXT NOT NULL,
      prompt TEXT NOT NULL, cwd TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    __setCodeAgentQueueRunnerForTests(makeRunner(sqlite));

    const service = new CodeAgentJobQueueService();
    const id = await service.enqueue({ demandId: 10, speckitPath: 's', prompt: 'p' });
    await service.markProcessing(id);
    await service.recordWorkerPid(id, process.pid);

    expect(
      (
        sqlite.prepare("PRAGMA table_info('code_agent_job_queue')").all() as Array<{ name: string }>
      ).map((column) => column.name),
    ).toContain('worker_pid');
  });

  it('recoverOnStartup não retorna jobs já concluídos', async () => {
    const service = freshService();
    const done = await service.enqueue({ demandId: 1, speckitPath: 's', prompt: 'p' });
    await service.markDone(done);
    const failed = await service.enqueue({ demandId: 2, speckitPath: 's', prompt: 'p' });
    await service.markFailed(failed, 'boom');

    const recovered = await new CodeAgentJobQueueService().recoverOnStartup();
    expect(recovered).toHaveLength(0);
  });

  it('incrementa attempts ao transicionar para processing', async () => {
    const service = freshService();
    const id = await service.enqueue({ demandId: 1, speckitPath: 's', prompt: 'p' });
    expect(attempts(id)).toBe(0);
    await service.markProcessing(id);
    expect(attempts(id)).toBe(1);
  });

  it('recupera processing com attempts < 3 para pending e incrementa attempts', async () => {
    const service = freshService();
    const id = await service.enqueue({ demandId: 1, speckitPath: 's', prompt: 'p' });
    await service.markProcessing(id);
    expect(attempts(id)).toBe(1);

    const recovered = await new CodeAgentJobQueueService().recoverOnStartup();
    expect(recovered.map((r) => r.id)).toContain(id);
    expect(status(id)).toBe('pending');
    expect(attempts(id)).toBe(2);
  });

  it('marca processing com attempts >= 3 como failed após restart', async () => {
    const service = freshService();
    const id = await service.enqueue({ demandId: 1, speckitPath: 's', prompt: 'p' });
    // Simula 3 tentativas anteriores
    active!.prepare('UPDATE code_agent_job_queue SET attempts = 3 WHERE id = ?').run(id);
    await service.markProcessing(id);

    const recovered = await new CodeAgentJobQueueService().recoverOnStartup();
    expect(recovered).toHaveLength(0);
    expect(status(id)).toBe('failed');
    const row = active!.prepare('SELECT error FROM code_agent_job_queue WHERE id = ?').get(id) as {
      error: string;
    };
    expect(row.error).toContain('max_attempts');
  });

  it('atualiza last_heartbeat_at ao marcar processing e via recordHeartbeat', async () => {
    const service = freshService();
    const id = await service.enqueue({ demandId: 1, speckitPath: 's', prompt: 'p' });
    await service.markProcessing(id);

    const afterProcessing = active!
      .prepare('SELECT last_heartbeat_at FROM code_agent_job_queue WHERE id = ?')
      .get(id) as { last_heartbeat_at: number };
    expect(afterProcessing.last_heartbeat_at).toBeGreaterThan(0);

    const before = Date.now();
    await service.recordHeartbeat(id);
    const after = active!
      .prepare('SELECT last_heartbeat_at FROM code_agent_job_queue WHERE id = ?')
      .get(id) as { last_heartbeat_at: number };
    expect(after.last_heartbeat_at).toBeGreaterThanOrEqual(before);
  });

  it('timeoutStaleProcessingJobs marca jobs sem heartbeat recente como failed', async () => {
    const service = freshService();
    const id = await service.enqueue({ demandId: 1, speckitPath: 's', prompt: 'p' });
    await service.markProcessing(id);

    active!
      .prepare('UPDATE code_agent_job_queue SET last_heartbeat_at = ? WHERE id = ?')
      .run(Date.now() - 120_000, id);

    const timedOut = await service.timeoutStaleProcessingJobs(60_000);
    expect(timedOut).toContain(id);
    expect(status(id)).toBe('failed');
    const row = active!.prepare('SELECT error FROM code_agent_job_queue WHERE id = ?').get(id) as {
      error: string;
    };
    expect(row.error).toBe('heartbeat_timeout');
  });

  it('timeoutStaleProcessingJobs ignora jobs com heartbeat recente', async () => {
    const service = freshService();
    const id = await service.enqueue({ demandId: 1, speckitPath: 's', prompt: 'p' });
    await service.markProcessing(id);

    const timedOut = await service.timeoutStaleProcessingJobs(60_000);
    expect(timedOut).toHaveLength(0);
    expect(status(id)).toBe('processing');
  });

  it('boot sequence recupera jobs em estados variados corretamente', async () => {
    const service = freshService();
    const pendingId = await service.enqueue({ demandId: 1, speckitPath: 'pending', prompt: 'p' });
    const processingId = await service.enqueue({
      demandId: 2,
      speckitPath: 'processing',
      prompt: 'p',
    });
    await service.markProcessing(processingId);
    const doneId = await service.enqueue({ demandId: 3, speckitPath: 'done', prompt: 'p' });
    await service.markDone(doneId);
    const failedId = await service.enqueue({ demandId: 4, speckitPath: 'failed', prompt: 'p' });
    await service.markFailed(failedId, 'x');

    const recovered = await new CodeAgentJobQueueService().recoverOnStartup();
    const recoveredIds = recovered.map((r) => r.id);

    expect(recoveredIds).toContain(pendingId);
    expect(recoveredIds).toContain(processingId);
    expect(recoveredIds).not.toContain(doneId);
    expect(recoveredIds).not.toContain(failedId);
    expect(status(processingId)).toBe('pending');
    expect(attempts(processingId)).toBe(2); // markProcessing (1) + recoverOnStartup (1)
  });

  function status(id: string): string {
    return (
      active!.prepare('SELECT status FROM code_agent_job_queue WHERE id = ?').get(id) as {
        status: string;
      }
    ).status;
  }

  function attempts(id: string): number {
    return (
      active!.prepare('SELECT attempts FROM code_agent_job_queue WHERE id = ?').get(id) as {
        attempts: number;
      }
    ).attempts;
  }
});
