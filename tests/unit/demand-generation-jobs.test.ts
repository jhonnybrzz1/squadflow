import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  run: vi.fn(async (_query: unknown) => undefined),
  all: vi.fn(async (_query: unknown) => [] as Record<string, unknown>[]),
}));

vi.mock('../../server/db', () => ({
  dbHelper: dbMock,
}));

import { DemandGenerationJobsService } from '../../server/services/demand-generation-jobs';

describe('DemandGenerationJobsService (spec 10066)', () => {
  let service: DemandGenerationJobsService;

  beforeEach(() => {
    dbMock.run.mockClear();
    dbMock.all.mockReset();
    dbMock.all.mockResolvedValue([]);
    service = new DemandGenerationJobsService();
  });

  it('persiste job pending antes do aceite HTTP', async () => {
    const id = await service.enqueue(10066, {
      agentIds: ['product_owner', 'tech_lead'],
      maxRounds: 2,
      refinementLevel: 3,
    });

    expect(id).toMatch(/[0-9a-f-]{36}/);
    const insert = dbMock.run.mock.calls.find((call) =>
      JSON.stringify(call[0]).includes('INSERT INTO demand_generation_jobs'),
    );
    expect(insert).toBeDefined();
    expect(JSON.stringify(insert![0])).toContain('pending');
    expect(JSON.stringify(insert![0])).toContain('product_owner');
  });

  it('transiciona running/succeeded/failed e incrementa attempts ao rodar', async () => {
    await service.markRunning('job-1');
    await service.markSucceeded('job-1');
    await service.markFailed('job-2', 'boom');

    const updates = dbMock.run.mock.calls
      .map((call) => JSON.stringify(call[0]))
      .filter((text) => text.includes('UPDATE demand_generation_jobs'));

    expect(updates).toHaveLength(3);
    expect(updates[0]).toContain('running');
    expect(updates[0]).toContain('attempts = attempts +');
    expect(updates[0]).toContain(',1,');
    expect(updates[1]).toContain('succeeded');
    expect(updates[2]).toContain('failed');
    expect(updates[2]).toContain('boom');
  });

  it('recoverOnStartup volta running órfão para pending na primeira retomada', async () => {
    const running = {
      id: 'orphan-1',
      demand_id: 10066,
      config: JSON.stringify({ agentIds: ['qa'], maxRounds: 1, refinementLevel: 2 }),
      status: 'running',
      attempts: 1,
      error: null,
      created_at: 1,
      updated_at: 1,
    };
    const pending = { ...running, status: 'pending' };

    dbMock.all.mockResolvedValueOnce([running]).mockResolvedValueOnce([pending]);

    const recovered = await service.recoverOnStartup();

    expect(recovered).toHaveLength(1);
    expect(recovered[0].status).toBe('pending');
    expect(recovered[0].config.agentIds).toEqual(['qa']);

    const updates = dbMock.run.mock.calls
      .map((call) => JSON.stringify(call[0]))
      .filter((text) => text.includes('UPDATE demand_generation_jobs'));
    expect(updates.some((text) => text.includes('pending'))).toBe(true);
  });

  it('recoverOnStartup retorna running recente para pending após restart', async () => {
    const now = Date.now();
    const running = {
      id: 'recent-running-1',
      demand_id: 10066,
      config: JSON.stringify({ agentIds: ['qa'], maxRounds: 1, refinementLevel: 2 }),
      status: 'running',
      attempts: 1,
      error: null,
      created_at: 1,
      updated_at: now,
    };
    const pending = { ...running, status: 'pending' };

    dbMock.all.mockResolvedValueOnce([running]).mockResolvedValueOnce([pending]);

    const recovered = await service.recoverOnStartup();

    expect(recovered).toHaveLength(1);
    expect(recovered[0].status).toBe('pending');

    const updates = dbMock.run.mock.calls
      .map((call) => JSON.stringify(call[0]))
      .filter((text) => text.includes('UPDATE demand_generation_jobs'));
    expect(updates.some((text) => text.includes('pending'))).toBe(true);
    expect(updates.some((text) => text.includes('interrupted_by_restart_retrying'))).toBe(true);
  });

  it('recoverOnStartup marca failed quando running já reincidiu', async () => {
    const running = {
      id: 'orphan-2',
      demand_id: 10066,
      config: JSON.stringify({ agentIds: ['qa'], maxRounds: 1, refinementLevel: 2 }),
      status: 'running',
      attempts: 2,
      error: null,
      created_at: 1,
      updated_at: 1,
    };

    dbMock.all.mockResolvedValueOnce([running]).mockResolvedValueOnce([]);

    await service.recoverOnStartup();

    const updates = dbMock.run.mock.calls
      .map((call) => JSON.stringify(call[0]))
      .filter((text) => text.includes('UPDATE demand_generation_jobs'));
    expect(updates.some((text) => text.includes('failed'))).toBe(true);
    expect(updates.some((text) => text.includes('interrupted_by_restart'))).toBe(true);
  });
});
