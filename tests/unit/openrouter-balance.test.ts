import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OpenRouterBalanceService,
  parseLowBalanceThreshold,
} from '../../server/services/openrouter-balance';

function response(data: unknown, ok = true, status = 200): Response {
  return { ok, status, json: vi.fn().mockResolvedValue(data) } as unknown as Response;
}

describe('OpenRouterBalanceService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calcula saldo, classifica e reutiliza cache durante o TTL', async () => {
    let now = 1_700_000_000_000;
    const fetchFn = vi
      .fn()
      .mockResolvedValue(response({ data: { total_credits: 10, total_usage: 2 } }));
    const service = new OpenRouterBalanceService({
      fetchFn,
      now: () => now,
      apiKey: () => 'secret',
    });

    await expect(service.getBalance()).resolves.toMatchObject({
      balance: 8,
      status: 'ok',
      stale: false,
    });
    now += 299_999;
    await service.getBalance();
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('deduplica atualizações concorrentes', async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchFn = vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve)));
    const service = new OpenRouterBalanceService({ fetchFn, apiKey: () => 'secret' });
    const first = service.getBalance();
    const second = service.getBalance();
    resolveFetch(response({ data: { total_credits: 1, total_usage: 0.5 } }));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('saldo esgotado (uso == créditos) classifica como empty', async () => {
    const service = new OpenRouterBalanceService({
      fetchFn: vi
        .fn()
        .mockResolvedValue(response({ data: { total_credits: 12, total_usage: 12 } })),
      apiKey: () => 'secret',
    });
    await expect(service.getBalance()).resolves.toMatchObject({
      balance: 0,
      limit: 12,
      usage: 12,
      status: 'empty',
    });
  });

  it('preserva snapshot como stale após falha e falha no cold start', async () => {
    let now = 1_700_000_000_000;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response({ data: { total_credits: 2, total_usage: 1 } }))
      .mockResolvedValueOnce(response({}, false, 401));
    const service = new OpenRouterBalanceService({
      fetchFn,
      now: () => now,
      apiKey: () => 'secret',
      ttlMs: 10,
    });
    await service.getBalance();
    now += 11;
    await expect(service.getBalance()).resolves.toMatchObject({
      balance: 1,
      stale: true,
      status: 'error',
    });

    const cold = new OpenRouterBalanceService({
      fetchFn: vi.fn().mockRejectedValue(new Error('network')),
      apiKey: () => 'secret',
    });
    await expect(cold.getBalance()).rejects.toThrow('unavailable');
  });

  it('rejeita payload inválido e usa threshold seguro', async () => {
    const service = new OpenRouterBalanceService({
      fetchFn: vi.fn().mockResolvedValue(response({ data: { total_credits: 2, total_usage: -1 } })),
      apiKey: () => 'secret',
    });
    await expect(service.getBalance()).rejects.toThrow('unavailable');
    expect(parseLowBalanceThreshold('invalid')).toBe(1);
    expect(parseLowBalanceThreshold('2.5')).toBe(2.5);
  });
});
