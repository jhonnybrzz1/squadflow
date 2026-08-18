import { beforeEach, describe, expect, it, vi } from 'vitest';

const repoMock = vi.hoisted(() => ({
  findByIdOrNull: vi.fn(async () => ({ id: 10066, status: 'processing', progress: 0 })),
  update: vi.fn(async () => undefined),
}));

const squadMock = vi.hoisted(() => ({
  isStopRequested: vi.fn(() => false),
  processDemand: vi.fn(
    async (_demandId: number, onProgress: (message: unknown) => Promise<void>) => {
      await onProgress({
        progress: 60,
        agent: 'cognitive_core',
        message: 'processando sequencial',
        timestamp: '2026-07-22T00:00:00.000Z',
        type: 'processing',
      });
    },
  ),
  processDemandRoundtable: vi.fn(
    async (
      _demandId: number,
      _config: unknown,
      onProgress: (message: unknown) => Promise<void>,
    ) => {
      await onProgress({
        progress: 50,
        agent: 'tech_lead',
        message: 'processando',
        timestamp: '2026-07-22T00:00:00.000Z',
        type: 'roundtable_agent_message',
      });
    },
  ),
}));

const jobsMock = vi.hoisted(() => ({
  markRunning: vi.fn(async () => undefined),
  markSucceeded: vi.fn(async () => undefined),
  markFailed: vi.fn(async () => undefined),
  recoverOnStartup: vi.fn(async () => []),
}));

const sseMock = vi.hoisted(() => ({
  sendProgress: vi.fn(),
}));

vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: repoMock,
}));

vi.mock('../../server/services/ai-squad', () => ({
  aiSquadService: squadMock,
}));

vi.mock('../../server/services/demand-generation-jobs', () => ({
  demandGenerationJobsService: jobsMock,
}));

vi.mock('../../server/services/sse', () => ({
  sseManager: sseMock,
}));

import {
  enqueueDemandGenerationJob,
  recoverDemandGenerationJobsOnStartup,
  whenDemandGenerationWorkerIdle,
} from '../../server/workers/demand-generation-worker';

describe('demand generation worker (spec 10066)', () => {
  beforeEach(async () => {
    await whenDemandGenerationWorkerIdle();
    repoMock.findByIdOrNull.mockClear();
    repoMock.update.mockClear();
    squadMock.isStopRequested.mockClear();
    squadMock.processDemand.mockClear();
    squadMock.processDemandRoundtable.mockClear();
    jobsMock.markRunning.mockClear();
    jobsMock.markSucceeded.mockClear();
    jobsMock.markFailed.mockClear();
    jobsMock.recoverOnStartup.mockReset();
    jobsMock.recoverOnStartup.mockResolvedValue([]);
    sseMock.sendProgress.mockClear();
  });

  it('consome job, executa roundtable, publica progresso e marca succeeded', async () => {
    enqueueDemandGenerationJob({
      id: 'job-10066',
      demandId: 10066,
      config: { agentIds: ['tech_lead'], maxRounds: 1, refinementLevel: 3 },
      status: 'pending',
      attempts: 0,
      error: null,
      createdAt: 1,
      updatedAt: 1,
    });

    await whenDemandGenerationWorkerIdle();

    expect(jobsMock.markRunning).toHaveBeenCalledWith('job-10066');
    expect(squadMock.processDemandRoundtable).toHaveBeenCalledWith(
      10066,
      { agentIds: ['tech_lead'], maxRounds: 1, refinementLevel: 3 },
      expect.any(Function),
    );
    expect(repoMock.update).toHaveBeenCalledWith(10066, {
      status: 'processing',
      progress: 50,
    });
    expect(sseMock.sendProgress).toHaveBeenCalledWith(
      10066,
      50,
      expect.objectContaining({ agent: 'tech_lead', message: 'processando' }),
    );
    expect(jobsMock.markSucceeded).toHaveBeenCalledWith('job-10066');
    expect(jobsMock.markFailed).not.toHaveBeenCalled();
  });

  it('recupera jobs duráveis no startup e reencaminha para processamento', async () => {
    jobsMock.recoverOnStartup.mockResolvedValueOnce([
      {
        id: 'job-recovered',
        demandId: 10067,
        config: { agentIds: ['qa'], maxRounds: 1, refinementLevel: 2 },
        status: 'pending',
        attempts: 0,
        error: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const count = await recoverDemandGenerationJobsOnStartup();
    await whenDemandGenerationWorkerIdle();

    expect(count).toBe(1);
    expect(jobsMock.markRunning).toHaveBeenCalledWith('job-recovered');
    expect(squadMock.processDemandRoundtable).toHaveBeenCalledWith(
      10067,
      { agentIds: ['qa'], maxRounds: 1, refinementLevel: 2 },
      expect.any(Function),
    );
  });
});
