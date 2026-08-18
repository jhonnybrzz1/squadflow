import client from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Demanda 10321 — instrumentação de throughput de demandas.
 *
 * A retrospectiva registrou queda de 11 para 1 demanda no período e não
 * conseguiu apontar a causa (backlog seco, demanda travada ou falha silenciosa)
 * porque não havia contagem nenhuma. O baseline continua **A MEDIR — sem
 * baseline**: estes contadores existem para produzi-lo.
 *
 * Estes testes fixam duas coisas: que o desfecho é contado com o rótulo certo,
 * e que a telemetria nunca derruba a transição de estado.
 */

const update = vi.fn();
const create = vi.fn();

vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: {
    update: (...args: unknown[]) => update(...args),
    create: (...args: unknown[]) => create(...args),
    findByIdOrNull: vi.fn(),
  },
}));

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../../server/utils/logger', () => ({ logger: loggerMocks }));

async function counterValue(name: string, labels: Record<string, string>): Promise<number> {
  const metric = await client.register.getSingleMetric(name)?.get();
  const match = metric?.values.find((v) =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return match?.value ?? 0;
}

describe('throughput de demandas (10321)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['completed', 'error', 'stopped'])(
    'conta o desfecho %s com o tipo da demanda',
    async (status) => {
      const { DemandService } = await import('../../server/services/demand-service');
      update.mockResolvedValue({ id: 1, type: 'revisao', status });

      const before = await counterValue('demand_terminal_state_total', {
        status,
        demand_type: 'revisao',
      });
      await DemandService.updateStatus(1, status as never);
      const after = await counterValue('demand_terminal_state_total', {
        status,
        demand_type: 'revisao',
      });

      expect(after).toBe(before + 1);
    },
  );

  it('não conta estados intermediários — só desfecho fecha o ciclo', async () => {
    const { DemandService } = await import('../../server/services/demand-service');
    update.mockResolvedValue({ id: 1, type: 'revisao', status: 'processing' });

    const before = await counterValue('demand_terminal_state_total', {
      status: 'processing',
      demand_type: 'revisao',
    });
    await DemandService.updateStatus(1, 'processing' as never);
    const after = await counterValue('demand_terminal_state_total', {
      status: 'processing',
      demand_type: 'revisao',
    });

    expect(after).toBe(before);
  });

  it('usa "unknown" quando a demanda não tem tipo, em vez de perder o evento', async () => {
    const { DemandService } = await import('../../server/services/demand-service');
    update.mockResolvedValue({ id: 2, type: null, status: 'completed' });

    const before = await counterValue('demand_terminal_state_total', {
      status: 'completed',
      demand_type: 'unknown',
    });
    await DemandService.updateStatus(2, 'completed' as never);
    const after = await counterValue('demand_terminal_state_total', {
      status: 'completed',
      demand_type: 'unknown',
    });

    expect(after).toBe(before + 1);
  });

  it('falha de telemetria não derruba a transição de estado', async () => {
    const { DemandService } = await import('../../server/services/demand-service');
    const metric = client.register.getSingleMetric('demand_terminal_state_total') as {
      inc: (labels: Record<string, string>) => void;
    };
    const original = metric.inc;
    metric.inc = () => {
      throw new Error('registry indisponível');
    };
    update.mockResolvedValue({ id: 3, type: 'revisao', status: 'completed' });

    try {
      await expect(DemandService.updateStatus(3, 'completed' as never)).resolves.toMatchObject({
        id: 3,
      });
      expect(loggerMocks.warn).toHaveBeenCalled();
    } finally {
      metric.inc = original;
    }
  });
});
