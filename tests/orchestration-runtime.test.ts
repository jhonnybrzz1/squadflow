import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '@shared/schema';
import { OrchestrationRuntimeService } from '../server/services/orchestration-runtime';
import type { DbClient } from '../server/db';

const SCHEMA_SQL = `
  CREATE TABLE demands (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, domain TEXT);
  CREATE TABLE orchestration_runs (
    run_id TEXT PRIMARY KEY NOT NULL,
    demand_id INTEGER NOT NULL,
    pipeline_id TEXT,
    mode TEXT NOT NULL DEFAULT 'sequential',
    status TEXT NOT NULL,
    agent_order TEXT,
    error_message TEXT,
    regulatory_context TEXT,
    sensitivity_level TEXT,
    norma_referencia TEXT,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost_estimated REAL,
    metadata TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE TABLE agent_turns (
    turn_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    demand_id INTEGER NOT NULL,
    agent_name TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT,
    duration_ms INTEGER,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost_estimated REAL,
    metadata TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE TABLE agent_tool_calls (
    tool_call_id TEXT PRIMARY KEY NOT NULL,
    turn_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    status TEXT NOT NULL,
    args_json TEXT,
    result_json TEXT,
    error_message TEXT,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE orchestration_events (
    event_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    demand_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    agent_name TEXT,
    payload TEXT,
    created_at INTEGER NOT NULL
  );
`;

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(SCHEMA_SQL);
  sqlite.prepare('INSERT INTO demands (id, title, domain) VALUES (1, ?, ?)').run('demo', 'outro');
  const db = drizzle(sqlite, { schema }) as unknown as DbClient;
  return { sqlite, db };
}

describe('OrchestrationRuntimeService', () => {
  let activeDb: Database.Database | null = null;

  afterEach(() => {
    activeDb?.close();
    activeDb = null;
  });

  it('persiste um run com campos de conformidade e o conclui', async () => {
    const { sqlite, db } = createTestDb();
    activeDb = sqlite;
    const service = new OrchestrationRuntimeService(db);

    const runId = service.startRun({
      demandId: 1,
      agentOrder: ['pm', 'tech_lead'],
      regulatoryContext: 'outro',
      sensitivityLevel: 'restricted',
      normaReferencia: 'RMCCI-1.2',
    });
    expect(runId).toBeTruthy();

    await service.flush();
    const runRow = sqlite
      .prepare(
        'SELECT status, regulatory_context, sensitivity_level, norma_referencia, tokens_in FROM orchestration_runs WHERE run_id = ?',
      )
      .get(runId) as Record<string, unknown>;
    expect(runRow.status).toBe('running');
    expect(runRow.regulatory_context).toBe('outro');
    expect(runRow.sensitivity_level).toBe('restricted');
    expect(runRow.norma_referencia).toBe('RMCCI-1.2');
    expect(runRow.tokens_in).toBeNull(); // nullable

    service.completeRun(runId, { tokensIn: 100, tokensOut: 200, costEstimated: 0.01 });
    await service.flush();
    const done = sqlite
      .prepare(
        'SELECT status, completed_at, tokens_in, cost_estimated FROM orchestration_runs WHERE run_id = ?',
      )
      .get(runId) as Record<string, unknown>;
    expect(done.status).toBe('completed');
    expect(done.completed_at).toBeTruthy();
    expect(done.tokens_in).toBe(100);
    expect(done.cost_estimated).toBeCloseTo(0.01);
  });

  it('marca run como failed com errorMessage', async () => {
    const { sqlite, db } = createTestDb();
    activeDb = sqlite;
    const service = new OrchestrationRuntimeService(db);
    const runId = service.startRun({ demandId: 1 });
    service.failRun(runId, 'boom');
    await service.flush();
    const row = sqlite
      .prepare('SELECT status, error_message FROM orchestration_runs WHERE run_id = ?')
      .get(runId) as Record<string, unknown>;
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe('boom');
  });

  it('persiste turnos de agente com sucesso e falha', async () => {
    const { sqlite, db } = createTestDb();
    activeDb = sqlite;
    const service = new OrchestrationRuntimeService(db);
    const runId = service.startRun({ demandId: 1 });

    const okTurn = service.startAgentTurn({ runId, demandId: 1, agentName: 'pm', turnIndex: 0 });
    service.completeAgentTurn(okTurn, { durationMs: 1500 });

    const badTurn = service.startAgentTurn({
      runId,
      demandId: 1,
      agentName: 'qa',
      turnIndex: 1,
    });
    service.failAgentTurn(badTurn, 'agent crashed');

    await service.flush();
    const ok = sqlite
      .prepare('SELECT status, duration_ms FROM agent_turns WHERE turn_id = ?')
      .get(okTurn) as Record<string, unknown>;
    expect(ok.status).toBe('completed');
    expect(ok.duration_ms).toBe(1500);

    const bad = sqlite
      .prepare('SELECT status, error_message FROM agent_turns WHERE turn_id = ?')
      .get(badTurn) as Record<string, unknown>;
    expect(bad.status).toBe('failed');
    expect(bad.error_message).toBe('agent crashed');
  });

  it('registra tool calls e eventos', async () => {
    const { sqlite, db } = createTestDb();
    activeDb = sqlite;
    const service = new OrchestrationRuntimeService(db);
    const runId = service.startRun({ demandId: 1 });
    const turnId = service.startAgentTurn({ runId, demandId: 1, agentName: 'pm', turnIndex: 0 });

    service.recordToolCall({
      turnId,
      runId,
      toolName: 'read_file',
      status: 'completed',
      argsJson: { path: 'README.md' },
    });
    service.recordEvent({ runId, demandId: 1, eventType: 'ORCHESTRATION_STARTED' });

    await service.flush();
    const toolCount = sqlite
      .prepare('SELECT COUNT(*) as c FROM agent_tool_calls WHERE turn_id = ?')
      .get(turnId) as { c: number };
    expect(toolCount.c).toBe(1);
    const eventCount = sqlite
      .prepare('SELECT COUNT(*) as c FROM orchestration_events WHERE run_id = ?')
      .get(runId) as { c: number };
    expect(eventCount.c).toBe(1);
  });

  it('é fail-open: não lança quando o DB falha, e tenta com retry', async () => {
    let attempts = 0;
    const failingDb = {
      insert() {
        return {
          values() {
            attempts++;
            return Promise.reject(new Error('db down'));
          },
        };
      },
    } as unknown as DbClient;

    // baseBackoffMs=1 para o teste rodar rápido. O construtor recebe um objeto
    // RetryConfig — a forma posicional antiga (db, 2, 1) era silenciosamente
    // ignorada e o serviço caía no default do env (5 retries = 6 tentativas).
    const service = new OrchestrationRuntimeService(failingDb, {
      maxRetries: 2,
      baseBackoffMs: 1,
    });
    const runId = service.startRun({ demandId: 1 });
    expect(runId).toBeTruthy(); // retorna runId mesmo com DB quebrado

    await expect(service.flush()).resolves.toBeUndefined(); // não lança
    expect(attempts).toBe(3); // 1 tentativa + 2 retries
  });
});
