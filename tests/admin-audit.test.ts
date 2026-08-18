import { describe, expect, it, vi, afterEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { adminAuditMiddleware } from '../server/middleware/admin-audit';

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('adminAuditMiddleware', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registra identidade local no log', async () => {
    const { logger } = await import('../server/utils/logger');
    const middleware = adminAuditMiddleware('resetAI');

    const req = {
      ip: '203.0.113.42',
      socket: { remoteAddress: '203.0.113.42' },
      path: '/api/ai/usage/reset',
      method: 'POST',
    } as unknown as Request;

    const res = {
      statusCode: 200,
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;

    const next = vi.fn() as NextFunction;

    middleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();

    (res.json as unknown as ReturnType<typeof vi.fn>)({ success: true });

    expect(logger.info).toHaveBeenCalledWith(
      'Admin action executed',
      expect.objectContaining({
        context: expect.objectContaining({
          action: 'resetAI',
          adminId: 'local-user',
          adminRole: 'admin',
          adminName: 'Local User',
          isAuthenticated: true,
          ip: '203.0.113.x',
          path: '/api/ai/usage/reset',
          method: 'POST',
          status: 200,
          success: true,
        }),
      }),
    );
  });

  it('marca success false quando a resposta falha', async () => {
    const { logger } = await import('../server/utils/logger');
    const middleware = adminAuditMiddleware('clearCache');

    const req = {
      ip: '::1',
      socket: { remoteAddress: '::1' },
      path: '/api/ai/cache/clear',
      method: 'POST',
    } as unknown as Request;

    const res = {
      statusCode: 500,
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;

    const next = vi.fn() as NextFunction;

    middleware(req, res, next);
    (res.json as unknown as ReturnType<typeof vi.fn>)({ success: false });

    expect(logger.info).toHaveBeenCalledWith(
      'Admin action executed',
      expect.objectContaining({
        context: expect.objectContaining({
          action: 'clearCache',
          status: 500,
          success: false,
          ip: '::x',
        }),
      }),
    );
  });
});
