import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  all: vi.fn(async () => [] as unknown[]),
  run: vi.fn(async () => undefined),
}));

vi.mock('../../server/db', () => ({
  db: { all: dbMock.all, run: dbMock.run },
  dbHelper: dbMock,
  isPostgres: false,
}));

vi.mock('../../server/services/retention-policy', () => ({
  retentionPolicyService: {
    getActivePolicies: vi.fn(async () => []),
    getDbSizeMetrics: vi.fn(async () => ({ totalSizeMb: 1 })),
  },
}));

import { RetentionWorker } from '../../server/workers/retention-worker';

describe('Retenção honesta (spec 016 B2 / H-02)', () => {
  beforeEach(() => {
    dbMock.all.mockReset();
    dbMock.run.mockReset();
  });

  it('FR-006/US2-AS3: archive retorna NOT_IMPLEMENTED, zero linhas e nunca sucesso falso', async () => {
    // 5 linhas elegíveis — o sucesso falso antigo reportava rowsDeleted=5.
    dbMock.all.mockResolvedValue([{ count: 5 }]);

    const worker = new RetentionWorker();
    const result = await (
      worker as unknown as {
        executeWithRetry: (
          policy: Record<string, unknown>,
          cutoff: number | string,
        ) => Promise<{ success: boolean; error?: string; rowsDeleted: number }>;
      }
    ).executeWithRetry({ id: 1, dataType: 'telemetry', action: 'archive', ttlDays: 30 }, 123);

    expect(result.success).toBe(false);
    expect(result.error).toBe('NOT_IMPLEMENTED');
    expect(result.rowsDeleted).toBe(0);
    // Nenhum DELETE executado.
    expect(dbMock.run).not.toHaveBeenCalled();
  });

  it('delete continua funcionando com semântica SQLite (US2-AS1)', async () => {
    dbMock.all.mockResolvedValue([{ count: 3 }]);
    const worker = new RetentionWorker();
    const result = await (
      worker as unknown as {
        executeWithRetry: (
          policy: Record<string, unknown>,
          cutoff: number | string,
        ) => Promise<{ success: boolean; rowsDeleted: number }>;
      }
    ).executeWithRetry({ id: 2, dataType: 'telemetry', action: 'delete', ttlDays: 30 }, 123);

    expect(result.success).toBe(true);
    expect(result.rowsDeleted).toBe(3);
    expect(dbMock.run).toHaveBeenCalledTimes(1);
  });
});
