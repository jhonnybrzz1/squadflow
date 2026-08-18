import { describe, expect, it } from 'vitest';

import { retentionPolicyService } from '../../server/services/retention-policy';

describe('retention job log DTO (spec 10070)', () => {
  it('agrega linhas por política em um DTO de execução', () => {
    const dto = (
      retentionPolicyService as unknown as {
        toRetentionJobLogDtos: (logs: unknown[]) => Array<{
          id: number;
          status: string;
          dataTypesProcessed: string[];
          totalRowsDeleted: number;
          executionTimeMs: number;
          errorMessage: string | null;
          startedAt: string;
          completedAt: string | null;
        }>;
      }
    ).toRetentionJobLogDtos([
      {
        id: 10,
        runId: 'run-1',
        policyId: 1,
        dataType: 'chat_messages',
        executionStartedAt: new Date('2026-07-22T10:00:00.000Z'),
        executionCompletedAt: new Date('2026-07-22T10:00:01.500Z'),
        status: 'completed',
        rowsAffected: 2,
        errorMessage: null,
      },
      {
        id: 11,
        runId: 'run-1',
        policyId: 2,
        dataType: 'human_feedback',
        executionStartedAt: new Date('2026-07-22T10:00:00.250Z'),
        executionCompletedAt: new Date('2026-07-22T10:00:02.000Z'),
        status: 'completed',
        rowsAffected: 3,
        errorMessage: null,
      },
    ]);

    expect(dto).toEqual([
      {
        id: 10,
        status: 'completed',
        dataTypesProcessed: ['chat_messages', 'human_feedback'],
        totalRowsDeleted: 5,
        executionTimeMs: 2000,
        errorMessage: null,
        startedAt: '2026-07-22T10:00:00.000Z',
        completedAt: '2026-07-22T10:00:02.000Z',
      },
    ]);
  });

  it('agrega erro e status failed quando uma política falha', () => {
    const [dto] = (
      retentionPolicyService as unknown as {
        toRetentionJobLogDtos: (logs: unknown[]) => Array<{
          status: string;
          errorMessage: string | null;
        }>;
      }
    ).toRetentionJobLogDtos([
      {
        id: 20,
        runId: 'run-2',
        policyId: 1,
        dataType: 'chat_messages',
        executionStartedAt: new Date('2026-07-22T10:00:00.000Z'),
        executionCompletedAt: new Date('2026-07-22T10:00:01.000Z'),
        status: 'failed',
        rowsAffected: 0,
        errorMessage: 'db locked',
      },
    ]);

    expect(dto.status).toBe('failed');
    expect(dto.errorMessage).toBe('db locked');
  });
});
