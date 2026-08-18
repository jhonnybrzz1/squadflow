import { beforeEach, describe, expect, it, vi } from 'vitest';

const repoMock = vi.hoisted(() => ({
  findByIdOrNull: vi.fn(),
  update: vi.fn(async () => undefined),
}));

vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: repoMock,
}));

import {
  FrameworkDomainError,
  FrameworkManager,
} from '../../server/frameworks/framework-manager-facade';

const DEMAND = { id: 1, title: 'demanda', type: 'produto', priority: 'alta' };

describe('FrameworkManager facade (spec 013)', () => {
  let manager: FrameworkManager;

  beforeEach(async () => {
    repoMock.findByIdOrNull.mockReset();
    repoMock.update.mockReset();
    repoMock.findByIdOrNull.mockResolvedValue(DEMAND);
    manager = new FrameworkManager();
    await manager.initialize();
  });

  it('registra os frameworks padrão uma única vez', () => {
    const all = manager.getAllFrameworks();
    expect(all.length).toBeGreaterThanOrEqual(5);
    const ids = all.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('SC-004: inicializar duas vezes não altera a contagem', async () => {
    const before = manager.getAllFrameworks().length;
    await manager.initialize();
    await manager.initialize();
    expect(manager.getAllFrameworks().length).toBe(before);
  });

  it('getFrameworkById retorna o mesmo item da lista', () => {
    const first = manager.getAllFrameworks()[0];
    expect(manager.getFrameworkById(first.id)?.id).toBe(first.id);
  });

  it('métricas refletem o mesmo estado (legado inicializado junto)', () => {
    const metrics = manager.getFrameworkMetricsSummary();
    expect(Object.keys(metrics).length).toBeGreaterThan(0);
  });

  it('SC-003: execução bem-sucedida aparece no histórico', async () => {
    const first = manager.getAllFrameworks()[0];
    const fakeResult = {
      frameworkId: first.id,
      frameworkName: first.name,
      demandId: 1,
      status: 'completed',
      progress: 100,
      metrics: {},
      outputs: {},
      timeline: { startedAt: new Date().toISOString() },
      teamMembers: [],
      resourcesUsed: [],
    };
    // Stub determinístico: sem chamada de LLM em teste.
    const registry = (manager as unknown as { registry: { get: (id: string) => unknown } })
      .registry;
    const impl = registry.get(first.id) as { execute: unknown };
    impl.execute = vi.fn(async () => fakeResult);

    const result = await manager.executeFramework(1, first.id);
    expect(result.status).toBe('completed');

    const history = manager.getExecutionHistory('1');
    expect(history).toHaveLength(1);
    expect(history[0].frameworkId).toBe(first.id);
    expect(repoMock.update).toHaveBeenCalledWith(1, { frameworkExecution: fakeResult });
  });

  it('framework inexistente lança erro de domínio estável', async () => {
    await expect(manager.executeFramework(1, 'nao-existe')).rejects.toBeInstanceOf(
      FrameworkDomainError,
    );
  });

  it('demanda inexistente lança erro de domínio estável', async () => {
    repoMock.findByIdOrNull.mockResolvedValue(null);
    await expect(
      manager.executeFramework(999, manager.getAllFrameworks()[0].id),
    ).rejects.toBeInstanceOf(FrameworkDomainError);
  });

  it('FR-006: histórico vazio em memória deriva do frameworkExecution persistido', async () => {
    repoMock.findByIdOrNull.mockResolvedValue({
      ...DEMAND,
      frameworkExecution: { frameworkId: 'jtbd', status: 'completed' },
    });
    const history = await manager.getExecutionHistoryAsync('1');
    expect(history).toHaveLength(1);
    expect(history[0].frameworkId).toBe('jtbd');
  });

  it('getExecutionHistoryAsync prioriza a memória quando há execuções', async () => {
    const first = manager.getAllFrameworks()[0];
    const registry = (manager as unknown as { registry: { get: (id: string) => unknown } })
      .registry;
    const impl = registry.get(first.id) as { execute: unknown };
    impl.execute = vi.fn(async () => ({ frameworkId: first.id, status: 'completed' }));
    await manager.executeFramework(1, first.id);

    const history = await manager.getExecutionHistoryAsync('1');
    expect(history).toHaveLength(1);
    expect(repoMock.findByIdOrNull).toHaveBeenCalledTimes(1); // só a da execução
  });
});
