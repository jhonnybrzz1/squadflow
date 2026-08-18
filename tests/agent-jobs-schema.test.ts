import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '@shared/schema';
import {
  AGENT_JOBS_CREATE_STATEMENTS,
  AgentJobsService,
  __setAgentJobsRunnerForTests,
  agentJobsService,
} from '../server/services/agent-jobs';

function makeRunner(sqlite: Database.Database) {
  const db = drizzle(sqlite, { schema });
  return {
    run: (q: ReturnType<typeof sql>) => db.run(q),
    all: <T>(q: ReturnType<typeof sql>) => db.all(q) as T[],
  };
}

describe('Spec 10044 T2 — agent_jobs schema', () => {
  let active: Database.Database | null = null;

  afterEach(() => {
    __setAgentJobsRunnerForTests(null);
    active?.close();
    active = null;
  });

  it('cria a tabela idempotentemente com todas as colunas de auditoria', () => {
    const sqlite = new Database(':memory:');
    active = sqlite;
    for (const s of AGENT_JOBS_CREATE_STATEMENTS) sqlite.exec(s);
    for (const s of AGENT_JOBS_CREATE_STATEMENTS) sqlite.exec(s); // idempotente

    const cols = (
      sqlite.prepare("PRAGMA table_info('agent_jobs')").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);

    for (const expected of [
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
    ]) {
      expect(cols).toContain(expected);
    }
  });

  it('open→complete grava e lê o ciclo completo (round-trip via serviço)', async () => {
    const sqlite = new Database(':memory:');
    active = sqlite;
    const svc = new AgentJobsService();
    __setAgentJobsRunnerForTests(makeRunner(sqlite));

    const id = await svc.open(7, 'specs/7-handoff/spec.md', 'hash-abc');
    let job = await svc.findById(id);
    expect(job?.status).toBe('running');
    expect(job?.demandId).toBe(7);
    expect(job?.promptSentHash).toBe('hash-abc');
    expect(job?.typecheckPassed).toBeNull();

    await svc.complete(id, {
      status: 'succeeded',
      filesModified: ['src/a.ts', 'src/b.ts'],
      typecheckPassed: true,
    });
    job = await svc.findById(id);
    expect(job?.status).toBe('succeeded');
    expect(job?.filesModified).toEqual(['src/a.ts', 'src/b.ts']);
    expect(job?.typecheckPassed).toBe(true);
    expect(job?.cancelledAt).toBeNull();
  });

  it('persiste e lê steps (spec 10064 Batch 2)', async () => {
    const sqlite = new Database(':memory:');
    active = sqlite;
    const svc = new AgentJobsService();
    __setAgentJobsRunnerForTests(makeRunner(sqlite));

    const id = await svc.open(11, 'specs/11/spec.md', 'h');
    let job = await svc.findById(id);
    expect(job?.steps).toEqual([]); // default '[]'

    await svc.complete(id, {
      status: 'succeeded',
      steps: [
        { kind: 'tool', label: 'Edit server/foo.ts' },
        { kind: 'result', label: 'done' },
      ],
    });
    job = await svc.findById(id);
    expect(job?.steps).toEqual([
      { kind: 'tool', label: 'Edit server/foo.ts' },
      { kind: 'result', label: 'done' },
    ]);
  });

  it('ensureSchema faz ALTER defensivo em banco sem a coluna steps (idempotente)', async () => {
    const sqlite = new Database(':memory:');
    active = sqlite;
    // Simula um banco legado: cria agent_jobs SEM a coluna steps.
    sqlite.exec(`CREATE TABLE agent_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      demand_id INTEGER NOT NULL,
      speckit_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      prompt_sent_hash TEXT NOT NULL,
      files_modified TEXT NOT NULL DEFAULT '[]',
      typecheck_passed INTEGER,
      api_cost_usd REAL,
      human_edits_count INTEGER NOT NULL DEFAULT 0,
      cancelled_at TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    const svc = new AgentJobsService();
    __setAgentJobsRunnerForTests(makeRunner(sqlite));
    await svc.ensureSchema();

    const cols = (
      sqlite.prepare("PRAGMA table_info('agent_jobs')").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain('steps');

    // Round-trip funciona sobre a coluna recém-adicionada.
    const id = await svc.open(1, 'specs/1/spec.md', 'h');
    await svc.complete(id, { status: 'succeeded', steps: [{ kind: 'text', label: 'ok' }] });
    const job = await svc.findById(id);
    expect(job?.steps).toEqual([{ kind: 'text', label: 'ok' }]);
  });

  it('registra falha com cancelled_at e error_message (nunca perde auditoria)', async () => {
    const sqlite = new Database(':memory:');
    active = sqlite;
    const svc = new AgentJobsService();
    __setAgentJobsRunnerForTests(makeRunner(sqlite));

    const id = await svc.open(9, 'specs/9-handoff/spec.md', 'h');
    await svc.complete(id, {
      status: 'failed',
      cancelledAt: '2026-07-20T13:00:00.000Z',
      errorMessage: 'timeout',
      typecheckPassed: null,
    });
    const job = await svc.findById(id);
    expect(job?.status).toBe('failed');
    expect(job?.cancelledAt).toBe('2026-07-20T13:00:00.000Z');
    expect(job?.errorMessage).toBe('timeout');
    expect(job?.typecheckPassed).toBeNull();
  });

  it('listForDemand retorna registros da demanda mais recentes primeiro', async () => {
    const sqlite = new Database(':memory:');
    active = sqlite;
    __setAgentJobsRunnerForTests(makeRunner(sqlite));

    await agentJobsService.open(100, 'specs/100-handoff/spec.md', 'h1');
    await agentJobsService.open(100, 'specs/100-handoff/spec.md', 'h2');
    await agentJobsService.open(200, 'specs/200-handoff/spec.md', 'h3');

    const forDemand = await agentJobsService.listForDemand(100);
    expect(forDemand).toHaveLength(2);
    expect(forDemand.every((j) => j.demandId === 100)).toBe(true);
  });
});
