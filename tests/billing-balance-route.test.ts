import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getBalance } = vi.hoisted(() => ({ getBalance: vi.fn() }));
vi.mock('../server/services/openrouter-balance', () => ({
  openRouterBalanceService: { getBalance },
}));

import billingRouter from '../server/routes/billing';

describe('GET /api/billing/balance', () => {
  const app = express().use('/api/billing', billingRouter);

  beforeEach(() => vi.clearAllMocks());

  it('retorna o contrato sanitizado', async () => {
    getBalance.mockResolvedValue({
      balance: 8,
      usage: 2,
      limit: 10,
      currency: 'USD',
      stale: false,
      cachedAt: '2026-07-16T12:00:00.000Z',
      status: 'ok',
    });
    const result = await request(app).get('/api/billing/balance');
    expect(result.status).toBe(200);
    expect(result.body).toEqual(
      expect.objectContaining({ balance: 8, currency: 'USD', stale: false }),
    );
    expect(JSON.stringify(result.body)).not.toMatch(/authorization|secret|apiKey/i);
  });

  it('retorna erro interno exato sem snapshot', async () => {
    getBalance.mockRejectedValue(new Error('upstream detail'));
    const result = await request(app).get('/api/billing/balance');
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: 'internal' });
  });
});
