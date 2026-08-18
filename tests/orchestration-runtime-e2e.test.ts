import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '@shared/schema';
import { eventBus } from '../server/events/event-bus';
import { OrchestrationRuntimeService } from '../server/services/orchestration-runtime';
import {
  registerOrchestrationRuntimeSubscriber,
  __resetOrchestrationRuntimeSubscriberForTests,
} from '../server/services/orchestration-runtime-subscriber';
import type { DbClient } from '../server/db';

const UP = join(__dirname, '..', 'migrations', '0024_add_orchestration_runtime.sql');

function createTestDb() {
  const sqlite = new Database(':memory:');
  // Aplica a MESMA up migration usada em produção (não um schema duplicado).
  sqlite.exec(
    'CREATE TABLE demands (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, domain TEXT);',
  );
  sqlite.exec(readFileSync(UP, 'utf-8'));
  sqlite
    .prepare('INSERT INTO demands (id, title, domain) VALUES (1, ?, ?)')
    .run('e2e demo', 'geral');
  const db = drizzle(sqlite, { schema }) as unknown as DbClient;
  return { sqlite, db };
}

describe('Orchestration runtime e2e (subscriber + DB real)', () => {
  let activeDb: Database.Database | null = null;

  afterEach(() => {
    __resetOrchestrationRuntimeSubscriberForTests();
    activeDb?.close();
    activeDb = null;
  });

  it('uma demanda real gera runId, turnId e >=3 eventos críticos persistidos', async () => {
    const { sqlite, db } = createTestDb();
    activeDb = sqlite;

    const service = new OrchestrationRuntimeService(db);
    __resetOrchestrationRuntimeSubscriberForTests();
    registerOrchestrationRuntimeSubscriber(service);

    // Caminho de orquestração: cria o run (como faz o cognitive-orchestrator),
    // depois o eventBus reproduz o ciclo de vida emitido pelo agent-orchestrator.
    const runId = service.startRun({
      demandId: 1,
      agentOrder: ['pm', 'tech_lead'],
      regulatoryContext: 'geral',
      sensitivityLevel: 'restricted',
      normaReferencia: null,
    });
    const pipelineId = 'req-e2e-1';
    const ts = () => new Date().toISOString();

    eventBus.publish('ORCHESTRATION_STARTED', {
      timestamp: ts(),
      pipelineId,
      runId,
      demandId: 1,
      status: 'started',
      metadata: { totalAgents: 2 },
    });
    eventBus.publish('AGENT_STARTED', {
      timestamp: ts(),
      pipelineId,
      runId,
      demandId: 1,
      agentName: 'pm',
      turnIndex: 0,
      status: 'started',
    });
    eventBus.publish('AGENT_COMPLETED', {
      timestamp: ts(),
      pipelineId,
      runId,
      demandId: 1,
      agentName: 'pm',
      turnIndex: 0,
      status: 'completed',
      durationMs: 1200,
    });
    eventBus.publish('ORCHESTRATION_COMPLETED', {
      timestamp: ts(),
      pipelineId,
      runId,
      demandId: 1,
      status: 'completed',
      durationMs: 3400,
      metadata: { totalAgents: 2, successCount: 2, failedCount: 0 },
    });

    await service.flush();

    // runId persistido e concluído
    const run = sqlite
      .prepare('SELECT status, regulatory_context FROM orchestration_runs WHERE run_id = ?')
      .get(runId) as Record<string, unknown>;
    expect(run.status).toBe('completed');
    expect(run.regulatory_context).toBe('geral');

    // turnId persistido (turno do PM concluído)
    const turn = sqlite
      .prepare('SELECT turn_id, status FROM agent_turns WHERE run_id = ? AND agent_name = ?')
      .get(runId, 'pm') as Record<string, unknown>;
    expect(turn.turn_id).toBeTruthy();
    expect(turn.status).toBe('completed');

    // >=3 eventos críticos persistidos
    const events = sqlite
      .prepare('SELECT event_type FROM orchestration_events WHERE run_id = ? ORDER BY created_at')
      .all(runId) as Array<{ event_type: string }>;
    const types = events.map((e) => e.event_type);
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(types).toContain('ORCHESTRATION_STARTED');
    expect(types).toContain('AGENT_STARTED');
    expect(types).toContain('AGENT_COMPLETED');
    expect(types).toContain('ORCHESTRATION_COMPLETED');
  });

  it('persiste falha de agente e run failed', async () => {
    const { sqlite, db } = createTestDb();
    activeDb = sqlite;

    const service = new OrchestrationRuntimeService(db);
    __resetOrchestrationRuntimeSubscriberForTests();
    registerOrchestrationRuntimeSubscriber(service);

    const runId = service.startRun({ demandId: 1, agentOrder: ['qa'] });
    const pipelineId = 'req-e2e-fail';
    const ts = () => new Date().toISOString();

    eventBus.publish('AGENT_STARTED', {
      timestamp: ts(),
      pipelineId,
      runId,
      demandId: 1,
      agentName: 'qa',
      turnIndex: 0,
      status: 'started',
    });
    eventBus.publish('AGENT_FAILED', {
      timestamp: ts(),
      pipelineId,
      runId,
      demandId: 1,
      agentName: 'qa',
      turnIndex: 0,
      status: 'failed',
      durationMs: 50,
      error: 'agent boom',
    });
    eventBus.publish('ORCHESTRATION_FAILED', {
      timestamp: ts(),
      pipelineId,
      runId,
      demandId: 1,
      status: 'failed',
      durationMs: 60,
      error: 'agent boom',
    });

    await service.flush();

    const turn = sqlite
      .prepare('SELECT status, error_message FROM agent_turns WHERE run_id = ?')
      .get(runId) as Record<string, unknown>;
    expect(turn.status).toBe('failed');
    expect(turn.error_message).toBe('agent boom');

    const run = sqlite
      .prepare('SELECT status, error_message FROM orchestration_runs WHERE run_id = ?')
      .get(runId) as Record<string, unknown>;
    expect(run.status).toBe('failed');
    expect(run.error_message).toBe('agent boom');
  });
});
