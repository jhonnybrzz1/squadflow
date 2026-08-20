/**
 * Spec 008 / US8: em produção, respostas de erro JSON NUNCA incluem stack trace.
 *
 * O gate `NODE_ENV === 'development'` já existia em
 * server/middleware/error-handler.ts; estes testes tornam a garantia
 * verificável (T037).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../../server/utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { errorHandler } from '../../server/middleware/error-handler';

function createRes() {
  const res: Partial<Response> & { statusCode?: number; body?: Record<string, unknown> } = {};
  res.status = vi.fn().mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  }) as never;
  res.json = vi.fn().mockImplementation((body: Record<string, unknown>) => {
    res.body = body;
    return res;
  }) as never;
  res.setHeader = vi.fn().mockReturnValue(res) as never;
  return res as Response & { statusCode?: number; body?: Record<string, unknown> };
}

function createReq(): Request {
  return {
    path: '/api/test',
    method: 'GET',
    headers: { 'x-request-id': 'prod-check-008' },
  } as unknown as Request;
}

const next: NextFunction = vi.fn();
const originalNodeEnv = process.env.NODE_ENV;

describe('error-handler em production (spec 008 / US8)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('NODE_ENV=production: erro interno 500 sem stack/stackTrace na resposta', () => {
    process.env.NODE_ENV = 'production';
    const res = createRes();

    errorHandler(new Error('boom interno'), createReq(), res, next);

    expect(res.statusCode).toBe(500);
    expect(res.body).toBeDefined();
    expect(res.body).not.toHaveProperty('stack');
    expect(res.body).not.toHaveProperty('stackTrace');
    // Nenhum vestígio de frames em nenhum campo serializado
    expect(JSON.stringify(res.body)).not.toMatch(/\n\s+at\s/);
    // Contrato de suporte preservado
    expect(res.body).toMatchObject({
      errorCode: expect.any(String),
      statusCode: 500,
      path: '/api/test',
      requestId: 'prod-check-008',
    });
  });

  it('NODE_ENV=test (não-development): também não expõe stack', () => {
    process.env.NODE_ENV = 'test';
    const res = createRes();

    errorHandler(new Error('boom'), createReq(), res, next);

    expect(res.body).not.toHaveProperty('stack');
  });

  it('NODE_ENV=development: stack continua disponível para depuração', () => {
    process.env.NODE_ENV = 'development';
    const res = createRes();

    errorHandler(new Error('boom dev'), createReq(), res, next);

    expect(res.body).toHaveProperty('stack');
  });
});
