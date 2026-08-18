import { describe, expect, it, vi } from 'vitest';
import { DemandService } from '../../server/services/demand-service';
import type { DemandRepository } from '../../server/repositories/demand-repository';
import type { InsertDemand } from '@shared/schema';

describe('DemandService.create (spec 10151)', () => {
  it('recebe CreateDemandInput e delega ao repository com opções atômicas', async () => {
    const createMock = vi.fn(async (_data: InsertDemand, options?: Record<string, unknown>) => ({
      id: 99,
      title: 'Teste Service',
      roundtableConfig: options?.roundtableConfig,
    })) as unknown as DemandRepository['create'];

    const repository = {
      create: createMock,
    } as unknown as DemandRepository;

    const demand = await DemandService.create(
      {
        title: 'Teste Service',
        description: 'Descrição',
        originalDescription: 'Original',
        type: 'melhoria',
        priority: 'alta',
        domain: 'padrao',
        repoFullName: 'owner/repo',
        skillRawUrl: 'http://skill.sh',
        files: [
          {
            demandId: null,
            filename: 'a.txt',
            originalName: 'a.txt',
            mimeType: 'text/plain',
            size: 1,
            path: '/tmp/a.txt',
          },
        ],
        roundtableConfig: { agentIds: ['po'], maxRounds: 1 },
      },
      repository,
    );

    expect(demand.id).toBe(99);
    expect(demand.roundtableConfig).toEqual({ agentIds: ['po'], maxRounds: 1 });
    expect(createMock).toHaveBeenCalledTimes(1);

    const [data, options] = createMock.mock.calls[0];
    expect((data as Record<string, unknown>).title).toBe('Teste Service');
    expect((data as Record<string, unknown>).repoFullName).toBe('owner/repo');
    expect((options as Record<string, unknown>).files).toHaveLength(1);
    expect((options as Record<string, unknown>).roundtableConfig).toEqual({
      agentIds: ['po'],
      maxRounds: 1,
    });
  });

  // Spec 10015 (FR-001): goLiveMode é persistido quando passado no input.
  it('persiste goLiveMode=true quando passado no CreateDemandInput', async () => {
    const createMock = vi.fn(async (data: InsertDemand) => ({
      id: 100,
      ...(data as object),
    })) as unknown as DemandRepository['create'];
    const repository = { create: createMock } as unknown as DemandRepository;

    await DemandService.create(
      {
        title: 'Go-live test',
        description: 'desc',
        originalDescription: 'desc',
        type: 'melhoria',
        priority: 'alta',
        goLiveMode: true,
      },
      repository,
    );

    const [data] = createMock.mock.calls[0];
    expect((data as Record<string, unknown>).goLiveMode).toBe(true);
  });

  it('persiste goLiveMode=false (default) quando não passado', async () => {
    const createMock = vi.fn(async (data: InsertDemand) => ({
      id: 101,
      ...(data as object),
    })) as unknown as DemandRepository['create'];
    const repository = { create: createMock } as unknown as DemandRepository;

    await DemandService.create(
      {
        title: 'No go-live',
        description: 'desc',
        originalDescription: 'desc',
        type: 'melhoria',
        priority: 'alta',
      },
      repository,
    );

    const [data] = createMock.mock.calls[0];
    expect((data as Record<string, unknown>).goLiveMode).toBe(false);
  });
});
