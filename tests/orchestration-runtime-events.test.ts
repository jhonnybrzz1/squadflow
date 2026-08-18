import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '@shared/schema';
import { eventBus } from '../server/events/event-bus';
import { OrchestrationRuntimeService } from '../server/services/orchestration-runtime';
import {
  __resetOrchestrationRuntimeSubscriberForTests,
  getOrchestrationTurnId,
  registerOrchestrationRuntimeSubscriber,
} from '../server/services/orchestration-runtime-subscriber';
import type { DbClient } from '../server/db';

const UP = join(__dirname, '..', 'migrations', '0024_add_orchestration_runtime.sql');

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('CREATE TABLE demands (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT);');
  sqlite.exec(readFileSync(UP, 'utf-8'));
  sqlite.prepare('INSERT INTO demands (id, title) VALUES (1, ?)').run('runtime events');
  const db = drizzle(sqlite, { schema }) as unknown as DbClient;
  return { sqlite, db };
}

describe('Orchestration runtime event coverage', () => {
  let activeDb: Database.Database | null = null;

  afterEach(() => {
    __resetOrchestrationRuntimeSubscriberForTests();
    activeDb?.close();
    activeDb = null;
  });

  it('persiste tool call associada ao turno ativo via eventBus', async () => {
    const { sqlite, db } = createTestDb();
    activeDb = sqlite;
    const service = new OrchestrationRuntimeService(db);
    registerOrchestrationRuntimeSubscriber(service);

    const runId = service.startRun({ demandId: 1, pipelineId: 'pipe-tools' });
    await service.flush();

    eventBus.publish('AGENT_STARTED', {
      timestamp: new Date().toISOString(),
      pipelineId: 'pipe-tools',
      runId,
      demandId: 1,
      agentName: 'tech_lead',
      turnIndex: 0,
      status: 'started',
    });

    const turnId = getOrchestrationTurnId(runId, 0);
    expect(turnId).toBeTruthy();

    eventBus.publish('TOOL_CALL_COMPLETED', {
      timestamp: new Date().toISOString(),
      pipelineId: 'pipe-tools',
      runId,
      turnIndex: 0,
      demandId: 1,
      agentName: 'tech_lead',
      toolName: 'repo_search',
      status: 'completed',
      argsJson: { query: 'orchestration' },
      resultJson: { ok: true, data: ['server'] },
      durationMs: 42,
    });

    await service.flush();

    const tool = sqlite
      .prepare(
        'SELECT tool_name, status, duration_ms FROM agent_tool_calls WHERE run_id = ? AND turn_id = ?',
      )
      .get(runId, turnId) as Record<string, unknown>;
    expect(tool.tool_name).toBe('repo_search');
    expect(tool.status).toBe('completed');
    expect(tool.duration_ms).toBe(42);

    const event = sqlite
      .prepare(
        'SELECT event_type, agent_name FROM orchestration_events WHERE run_id = ? AND event_type = ?',
      )
      .get(runId, 'TOOL_CALL_COMPLETED') as Record<string, unknown>;
    expect(event.agent_name).toBe('tech_lead');
  });

  it('persiste divergencia da mesa redonda como evento de orquestracao', async () => {
    const { sqlite, db } = createTestDb();
    activeDb = sqlite;
    const service = new OrchestrationRuntimeService(db);
    registerOrchestrationRuntimeSubscriber(service);

    const runId = service.startRun({ demandId: 1, pipelineId: 'pipe-roundtable' });
    await service.flush();

    eventBus.publish('ROUNDTABLE_DIVERGENCE_RECORDED', {
      timestamp: new Date().toISOString(),
      pipelineId: 'pipe-roundtable',
      runId,
      demandId: 1,
      agentName: 'qa',
      turnIndex: 2,
      round: 1,
      content: 'Risco nao coberto nos criterios de aceite.',
      dialogueMove: 'challenge',
    });

    await service.flush();

    const event = sqlite
      .prepare(
        'SELECT event_type, agent_name, payload FROM orchestration_events WHERE run_id = ? AND event_type = ?',
      )
      .get(runId, 'ROUNDTABLE_DIVERGENCE_RECORDED') as Record<string, unknown>;
    expect(event.event_type).toBe('ROUNDTABLE_DIVERGENCE_RECORDED');
    expect(event.agent_name).toBe('qa');
    expect(String(event.payload)).toContain('Risco nao coberto');
  });
});
