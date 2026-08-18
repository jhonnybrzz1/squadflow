import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '@shared/schema';
import { OperationAttemptService, validateMvpGate } from '../server/services/operation-attempts';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE operation_attempts (
      attempt_id TEXT PRIMARY KEY NOT NULL,
      operation_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      demand_id INTEGER,
      status TEXT NOT NULL CHECK(status IN ('blocked', 'processing', 'completed', 'error')),
      gate_status TEXT NOT NULL CHECK(gate_status IN ('ready', 'blocked')),
      missing_fields TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
  `);

  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
  };
}

describe('MVP Gate operation attempts', () => {
  let activeDb: Database.Database | null = null;

  afterEach(() => {
    activeDb?.close();
    activeDb = null;
  });

  it('blocks attempts missing the three essential fields', () => {
    const result = validateMvpGate({
      title: '',
      description: '   ',
      flowContract: null,
    });

    expect(result.gateStatus).toBe('blocked');
    expect(result.missingFields).toEqual(['title', 'description', 'flowContract']);
  });

  it('persists a ready happy-path attempt with attempt_id and operation_id', async () => {
    const testDb = createTestDb();
    activeDb = testDb.sqlite;
    const service = new OperationAttemptService(testDb.db);

    const attempt = await service.createAttempt({
      operationType: 'refinement_mvp_gate',
      operationId: 'op-test-001',
      title: 'Fluxo document-only',
      description: 'Usar documento quando descricao estiver vazia.',
      flowContract: 'Happy path + DOCUMENT_TEXT_EMPTY + status persistido',
    });

    expect(attempt.status).toBe('processing');
    expect(attempt.gateStatus).toBe('ready');
    expect(attempt.operationId).toBe('op-test-001');
    expect(attempt.attemptId).toBeTruthy();

    const row = testDb.sqlite
      .prepare(
        'SELECT attempt_id, operation_id, status, gate_status, missing_fields FROM operation_attempts WHERE attempt_id = ?',
      )
      .get(attempt.attemptId) as any;

    expect(row.operation_id).toBe('op-test-001');
    expect(row.status).toBe('processing');
    expect(row.gate_status).toBe('ready');
    expect(JSON.parse(row.missing_fields)).toEqual([]);
  });

  it('persists blocked status and missing fields for incomplete attempts', async () => {
    const testDb = createTestDb();
    activeDb = testDb.sqlite;
    const service = new OperationAttemptService(testDb.db);

    const attempt = await service.createAttempt({
      operationType: 'refinement_mvp_gate',
      title: '',
      description: '',
      flowContract: '',
    });

    expect(attempt.status).toBe('blocked');
    expect(attempt.gateStatus).toBe('blocked');

    const row = testDb.sqlite
      .prepare(
        'SELECT status, gate_status, missing_fields FROM operation_attempts WHERE attempt_id = ?',
      )
      .get(attempt.attemptId) as any;

    expect(row.status).toBe('blocked');
    expect(row.gate_status).toBe('blocked');
    expect(JSON.parse(row.missing_fields)).toEqual(['title', 'description', 'flowContract']);
  });

  it('updates attempts to completed and error with observable status', async () => {
    const testDb = createTestDb();
    activeDb = testDb.sqlite;
    const service = new OperationAttemptService(testDb.db);

    const completed = await service.createAttempt({
      operationType: 'refinement_mvp_gate',
      title: 'Titulo',
      description: 'Descricao',
      flowContract: 'Contrato verificavel',
    });
    await service.completeAttempt(completed.attemptId);

    const completedRow = testDb.sqlite
      .prepare('SELECT status, completed_at FROM operation_attempts WHERE attempt_id = ?')
      .get(completed.attemptId) as any;
    expect(completedRow.status).toBe('completed');
    expect(completedRow.completed_at).toBeTruthy();

    const failed = await service.createAttempt({
      operationType: 'refinement_mvp_gate',
      title: 'Titulo',
      description: 'Descricao',
      flowContract: 'Contrato verificavel',
    });
    await service.failAttempt(
      failed.attemptId,
      'FLOW_CONTRACT_FAILED',
      'Contrato nao passou no teste.',
    );

    const failedRow = testDb.sqlite
      .prepare(
        'SELECT status, error_code, error_message FROM operation_attempts WHERE attempt_id = ?',
      )
      .get(failed.attemptId) as any;
    expect(failedRow.status).toBe('error');
    expect(failedRow.error_code).toBe('FLOW_CONTRACT_FAILED');
    expect(failedRow.error_message).toContain('Contrato');
  });
});
