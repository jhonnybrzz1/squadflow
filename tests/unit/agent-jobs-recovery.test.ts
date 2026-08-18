import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@shared/schema';
import {
  AgentJobsService,
  AGENT_JOBS_CREATE_STATEMENTS,
  __setAgentJobsRunnerForTests,
  type AgentJobsDbRunner,
} from '../../server/services/agent-jobs';

/**
 * Spec 10148: agent_jobs recoverOnStartup — valida reconciliação de jobs
 * running órfãos após crash/restart com filtro temporal de 5 minutos.
 */
function makeRunner(sqlite: Database.Database): AgentJobsDbRunner {
  const db = drizzle(sqlite, { schema });
  return {
    run: (q) => db.run(q),
    all: <T>(q: ReturnType<typeof sql>) => db.all(q) as T[],
  };
}

describe('AgentJobsService — recoverOnStartup (Spec 10148)', () => {
  let active: Database.Database | null = null;

  afterEach(() => {
    __setAgentJobsRunnerForTests(null);
    active?.close();
    active = null;
    vi.useRealTimers();
  });

  function freshService(): AgentJobsService {
    const sqlite = new Database(':memory:');
    active = sqlite;
    __setAgentJobsRunnerForTests(makeRunner(sqlite));
    return new AgentJobsService();
  }

  function status(id: string): string {
    return (
      active!.prepare('SELECT status FROM agent_jobs WHERE id = ?').get(id) as {
        status: string;
      }
    ).status;
  }

  it('cria a tabela idempotentemente com updated_at', async () => {
    const sqlite = new Database(':memory:');
    active = sqlite;
    for (const s of AGENT_JOBS_CREATE_STATEMENTS) sqlite.exec(s);
    for (const s of AGENT_JOBS_CREATE_STATEMENTS) sqlite.exec(s); // idempotente

    const cols = (
      sqlite.prepare("PRAGMA table_info('agent_jobs')").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain('updated_at');
  });

  it('marca job running órfão como failed após crash (updated_at > 5 min)', async () => {
    vi.useFakeTimers();
    const service = freshService();
    const id = await service.open(42, 'specs/42/spec.md', 'hash-1');

    // Simula 6 minutos de execução antes do crash.
    vi.advanceTimersByTime(6 * 60 * 1000);

    const recovered = await service.recoverOnStartup();
    // agent_jobs é auditoria; running órfãos viram failed, não são re-enfileirados.
    expect(recovered.map((r) => r.id)).not.toContain(id);
    expect(status(id)).toBe('failed');
  });

  it('não requeueia job running genuíno em restart rápido (< 5 min)', async () => {
    vi.useFakeTimers();
    const service = freshService();
    const id = await service.open(43, 'specs/43/spec.md', 'hash-2');

    // Avança apenas 30 segundos: ainda dentro do threshold.
    vi.advanceTimersByTime(30 * 1000);

    const recovered = await service.recoverOnStartup();
    expect(recovered).toHaveLength(0);
    expect(status(id)).toBe('running');
  });

  it('retorna jobs pendentes preexistentes', async () => {
    const service = freshService();
    const id = await service.open(44, 'specs/44/spec.md', 'hash-3');
    await service.complete(id, { status: 'succeeded' });

    // Volta o job para pending manualmente para simular pending pré-existente.
    active!.prepare("UPDATE agent_jobs SET status = 'pending' WHERE id = ?").run(id);

    const recovered = await service.recoverOnStartup();
    expect(recovered.map((r) => r.id)).toContain(id);
  });

  it('migra banco legado sem steps e updated_at sem perder dados (spec 10148)', async () => {
    const sqlite = new Database(':memory:');
    active = sqlite;

    // Simula tabela legada com o mínimo de colunas.
    sqlite.exec(`CREATE TABLE agent_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      demand_id INTEGER NOT NULL,
      speckit_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      prompt_sent_hash TEXT NOT NULL,
      files_modified TEXT,
      created_at INTEGER NOT NULL
    )`);

    const id = 'legacy-job-1';
    const createdAt = 1785000000;
    sqlite
      .prepare(
        `INSERT INTO agent_jobs (id, demand_id, speckit_path, status, prompt_sent_hash, files_modified, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, 999, 'specs/999/spec.md', 'running', 'hash-legacy', '[]', createdAt);

    __setAgentJobsRunnerForTests(makeRunner(sqlite));
    const service = new AgentJobsService();

    await expect(service.ensureSchema()).resolves.not.toThrow();

    const cols = (
      sqlite.prepare("PRAGMA table_info('agent_jobs')").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain('steps');
    expect(cols).toContain('updated_at');

    const idxs = (
      sqlite.prepare("PRAGMA index_list('agent_jobs')").all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(idxs).toContain('agent_jobs_updated_at_idx');

    const row = sqlite.prepare('SELECT * FROM agent_jobs WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    expect(row.demand_id).toBe(999);
    expect(row.steps).toBe('[]');
    expect(row.updated_at).toBe(createdAt);
  });
});
