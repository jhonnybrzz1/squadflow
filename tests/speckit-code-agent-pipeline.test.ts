import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@shared/schema';
import { eventBus, type SpeckitCompletedPayload } from '../server/events/event-bus';
import { HANDOFF_FORMAT, type HandoffManifest } from '@shared/handoff-manifest';
import { agentJobsService, __setAgentJobsRunnerForTests } from '../server/services/agent-jobs';
import {
  whenCodeAgentQueueIdle,
  __setCodeAgentForTests,
  __resetCodeAgentWorkerForTests,
} from '../server/workers/code-agent-worker';
import { __setCodeAgentQueueRunnerForTests } from '../server/services/code-agent-job-queue';
import { registerSpeckitCodeAgentSubscriber } from '../server/services/speckit-code-agent-subscriber';
import type {
  CodeAgentRequest,
  CodeAgentResult,
  CodeAgentOutcome,
  ICodeAgent,
} from '../server/services/code-agents/code-agent';

/** Agente mock: retorna um outcome configurável e observa concorrência/prompts. */
class MockCodeAgent implements ICodeAgent {
  readonly name = 'mock';
  outcome: CodeAgentOutcome = 'succeeded';
  active = 0;
  maxConcurrent = 0;
  calls: CodeAgentRequest[] = [];

  async run(request: CodeAgentRequest): Promise<CodeAgentResult> {
    this.active += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    this.calls.push(request);
    await new Promise((r) => setTimeout(r, 15));
    this.active -= 1;
    const succeeded = this.outcome === 'succeeded';
    return {
      outcome: this.outcome,
      exitCode: succeeded ? 0 : 1,
      stdout: '',
      stderr: '',
      errorMessage: succeeded ? undefined : `mock ${this.outcome}`,
    };
  }
}

function makeRunner(sqlite: Database.Database) {
  const db = drizzle(sqlite, { schema });
  return {
    run: (q: ReturnType<typeof sql>) => db.run(q),
    all: <T>(q: ReturnType<typeof sql>) => db.all(q) as T[],
  };
}

function manifest(overrides?: Partial<HandoffManifest>): HandoffManifest {
  return {
    format: HANDOFF_FORMAT,
    demand: { id: 42, title: 'D', type: 'nova_funcionalidade', priority: 'Média' },
    generatedAt: '2026-07-20T12:00:00.000Z',
    documents: [
      {
        path: 'specs/42-handoff/spec.md',
        kind: 'spec',
        sha256: 'a'.repeat(64),
        version: 1,
        updatedAt: null,
      },
    ],
    warnings: [],
    ...overrides,
  };
}

function payload(demandId: number, m?: HandoffManifest): SpeckitCompletedPayload {
  return {
    demandId,
    specDir: `specs/${demandId}-handoff`,
    specPath: `specs/${demandId}-handoff/spec.md`,
    specContent: '# Spec\nfaça X',
    manifest: m ?? manifest({ demand: { id: demandId, title: 'D', type: 't', priority: 'p' } }),
  };
}

let sqlite: Database.Database;
let mock: MockCodeAgent;
const prevEnv = { ...process.env };

beforeAll(() => {
  registerSpeckitCodeAgentSubscriber(); // idempotente; registra uma vez no processo
});

beforeEach(() => {
  sqlite = new Database(':memory:');
  __setAgentJobsRunnerForTests(makeRunner(sqlite));
  // CRÍTICO-01: o pipeline também persiste na fila durável. Sem injetar este
  // runner, `enqueueCodeAgentJob` caía no `dbHelper` global e gravava fixtures
  // em `code_agent_job_queue` do sqlite.db real.
  __setCodeAgentQueueRunnerForTests(makeRunner(sqlite));
  mock = new MockCodeAgent();
  __setCodeAgentForTests(mock);
  // Typecheck determinístico e rápido: sai 0 (passou).
  process.env.AGENT_TYPECHECK_CMD = 'node -e process.exit(0)';
  process.env.AGENT_AUTORUN_ENABLED = 'true';
});

afterEach(() => {
  __resetCodeAgentWorkerForTests();
  __setAgentJobsRunnerForTests(null);
  __setCodeAgentQueueRunnerForTests(null);
  sqlite.close();
  process.env.AGENT_AUTORUN_ENABLED = prevEnv.AGENT_AUTORUN_ENABLED;
  process.env.AGENT_TYPECHECK_CMD = prevEnv.AGENT_TYPECHECK_CMD;
});

afterAll(() => {
  process.env = prevEnv;
});

describe('Spec 10044 T6 — pipeline SPECKIT_COMPLETED → agente → agent_jobs', () => {
  it('(a) manifest válido → agente dispara → registro succeeded com typecheck', async () => {
    eventBus.publish('SPECKIT_COMPLETED', payload(42));
    await whenCodeAgentQueueIdle();

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].prompt).toContain('faça X');

    const jobs = await agentJobsService.listForDemand(42);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('succeeded');
    expect(jobs[0].typecheckPassed).toBe(true);
    expect(jobs[0].cancelledAt).toBeNull();
    expect(Array.isArray(jobs[0].filesModified)).toBe(true);
    expect(jobs[0].promptSentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('(b) manifest inválido (sem spec) → agente NÃO dispara → sem registro', async () => {
    const bad = manifest({
      documents: [
        { path: 'x/tasks.md', kind: 'tasks', sha256: 'b'.repeat(64), version: 1, updatedAt: null },
      ],
    });
    eventBus.publish('SPECKIT_COMPLETED', payload(50, bad));
    await whenCodeAgentQueueIdle();

    expect(mock.calls).toHaveLength(0);
    expect(await agentJobsService.listForDemand(50)).toHaveLength(0);
  });

  it('(c) timeout do agente → registro failed com cancelled_at, typecheck null', async () => {
    mock.outcome = 'timeout';
    eventBus.publish('SPECKIT_COMPLETED', payload(43));
    await whenCodeAgentQueueIdle();

    const jobs = await agentJobsService.listForDemand(43);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('failed');
    expect(jobs[0].cancelledAt).not.toBeNull();
    expect(jobs[0].typecheckPassed).toBeNull();
    expect(jobs[0].errorMessage).toMatch(/timeout/);
  });

  it('(d) binário ausente (spawn_error) → registro failed com cancelled_at', async () => {
    mock.outcome = 'spawn_error';
    eventBus.publish('SPECKIT_COMPLETED', payload(44));
    await whenCodeAgentQueueIdle();

    const jobs = await agentJobsService.listForDemand(44);
    expect(jobs[0].status).toBe('failed');
    expect(jobs[0].cancelledAt).not.toBeNull();
  });

  it('(e) dois eventos → processados sequencialmente (nunca 2 agentes juntos)', async () => {
    eventBus.publish('SPECKIT_COMPLETED', payload(60));
    eventBus.publish('SPECKIT_COMPLETED', payload(61));
    await whenCodeAgentQueueIdle();

    expect(mock.calls).toHaveLength(2);
    expect(mock.maxConcurrent).toBe(1);
    expect(await agentJobsService.listForDemand(60)).toHaveLength(1);
    expect(await agentJobsService.listForDemand(61)).toHaveLength(1);
  });

  it('(f) AGENT_AUTORUN_ENABLED != true → dormente, não dispara', async () => {
    process.env.AGENT_AUTORUN_ENABLED = 'false';
    eventBus.publish('SPECKIT_COMPLETED', payload(70));
    await whenCodeAgentQueueIdle();

    expect(mock.calls).toHaveLength(0);
    expect(await agentJobsService.listForDemand(70)).toHaveLength(0);
  });

  it('(g) evento não relacionado → subscriber ignora', async () => {
    eventBus.publish('ORCHESTRATION_COMPLETED', {
      timestamp: new Date().toISOString(),
      pipelineId: 'p',
      demandId: 99,
      status: 'completed',
    });
    await whenCodeAgentQueueIdle();
    expect(mock.calls).toHaveLength(0);
  });
});
