import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/db', () => ({
  db: {},
  dbHelper: { run: vi.fn(), all: vi.fn(() => []) },
}));

import { OrchestrationRuntimeService } from '../../server/services/orchestration-runtime';
import {
  getAuditLossState,
  recordAuditLoss,
  resetAuditLossState,
} from '../../server/services/audit-loss-tracker';

type WriteLogEntry = { op: string; at: number };

function makeDbStub(writeLog: WriteLogEntry[], insertDelayMs = 30) {
  // insert lento + update rápido: sem serialização, o update ultrapassaria o insert.
  const values = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, insertDelayMs));
    writeLog.push({ op: 'insert', at: Date.now() });
  });
  const where = vi.fn(async () => {
    writeLog.push({ op: 'update', at: Date.now() });
    return { changes: 1 };
  });
  return {
    insert: vi.fn(() => ({ values })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where })) })),
  };
}

describe('Ordenação da trilha de orquestração (spec 015 B3 / H-11)', () => {
  it('SC-003/FR-008: update do run NUNCA ultrapassa o insert (serialização por runId)', async () => {
    const writeLog: WriteLogEntry[] = [];
    const service = new OrchestrationRuntimeService(
      makeDbStub(writeLog) as never,
      0, // sem retries no teste
      1,
    );

    const runId = service.startRun({ demandId: 1 });
    service.completeRun(runId); // disparado imediatamente após o start
    await service.flush();

    expect(writeLog.map((w) => w.op)).toEqual(['insert', 'update']);
  });

  it('runs distintos permanecem paralelos (sem serialização global)', async () => {
    const writeLog: WriteLogEntry[] = [];
    const service = new OrchestrationRuntimeService(makeDbStub(writeLog, 20) as never, 0, 1);

    const runA = service.startRun({ demandId: 1 });
    const runB = service.startRun({ demandId: 2 });
    service.completeRun(runA);
    service.completeRun(runB);
    await service.flush();

    // 2 inserts + 2 updates, cada par ordenado dentro do seu run.
    expect(writeLog.filter((w) => w.op === 'insert')).toHaveLength(2);
    expect(writeLog.filter((w) => w.op === 'update')).toHaveLength(2);
  });

  it('FR-007: reconcileStaleRuns finaliza registros running órfãos', async () => {
    const updates: string[] = [];
    const dbStub = {
      update: vi.fn(() => ({
        set: vi.fn((fields: Record<string, unknown>) => ({
          where: vi.fn(async () => {
            updates.push(String(fields.errorMessage));
            return { changes: 1 };
          }),
        })),
      })),
    };
    const service = new OrchestrationRuntimeService(dbStub as never, 0, 1);
    const result = await service.reconcileStaleRuns();

    expect(result).toEqual({ runs: 1, turns: 1 });
    expect(updates).toEqual(['interrupted_by_restart', 'interrupted_by_restart']);
  });
});

describe('Perdas de auditoria observáveis (spec 015 B3 / M-07)', () => {
  beforeEach(() => resetAuditLossState());

  it('SC-004: perda simulada incrementa estado e degrada o health', () => {
    expect(getAuditLossState().degraded).toBe(false);
    recordAuditLoss('guardrail_log', new Error('disk full'));
    const state = getAuditLossState();
    expect(state.degraded).toBe(true);
    expect(state.totalLosses).toBe(1);
    expect(state.lastSink).toBe('guardrail_log');
  });
});
