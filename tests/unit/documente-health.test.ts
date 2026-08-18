import { describe, expect, it, vi } from 'vitest';
import { probeDocuMente } from '../../server/services/documente-health';

describe('probeDocuMente', () => {
  it('rejects a 403 port owner and accepts the next successful endpoint', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] });

    await expect(
      probeDocuMente(fetchFn as unknown as typeof fetch, [
        'http://localhost:5000',
        'http://localhost:3000',
      ]),
    ).resolves.toEqual({ online: true, url: 'http://localhost:3000' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('rejects an unrelated 200 response with a different payload shape', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ service: 'not-documente' }),
    });

    await expect(
      probeDocuMente(fetchFn as unknown as typeof fetch, ['http://localhost:3000']),
    ).resolves.toEqual({ online: false, url: null });
  });

  it('returns offline when no configured endpoint succeeds', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('connection refused'));

    await expect(
      probeDocuMente(fetchFn as unknown as typeof fetch, ['http://localhost:3000']),
    ).resolves.toEqual({ online: false, url: null });
  });
});
