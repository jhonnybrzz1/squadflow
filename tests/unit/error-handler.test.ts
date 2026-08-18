import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { ZodError, z } from 'zod';

vi.mock('../../server/utils/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { logger } from '../../server/utils/logger';
import {
  errorHandler,
  AppError,
  ValidationError,
  NotFoundError,
  RateLimitError,
} from '../../server/middleware/error-handler';

function createRes() {
  const res: Partial<Response> & {
    statusCode?: number;
    body?: any;
    headers: Record<string, string>;
  } = { headers: {} };
  res.status = vi.fn().mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  }) as any;
  res.json = vi.fn().mockImplementation((body: any) => {
    res.body = body;
    return res;
  }) as any;
  res.setHeader = vi.fn().mockImplementation((k: string, v: string) => {
    res.headers[k] = v;
    return res;
  }) as any;
  return res as Response & { statusCode?: number; body?: any; headers: Record<string, string> };
}

function createReq(headers: Record<string, string> = {}): Request {
  return {
    path: '/api/test',
    method: 'GET',
    headers,
  } as unknown as Request;
}

const next: NextFunction = vi.fn();

describe('errorHandler — contrato ErrorResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mantém o contrato base (error, errorCode, message, statusCode, timestamp, path)', () => {
    const res = createRes();
    errorHandler(new AppError('boom', 500, 'INTERNAL_ERROR'), createReq(), res, next);

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({
      error: 'Error',
      errorCode: 'INTERNAL_ERROR',
      message: 'boom',
      statusCode: 500,
      path: '/api/test',
    });
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('inclui requestId quando o header x-request-id está presente', () => {
    const res = createRes();
    errorHandler(
      new NotFoundError('Demanda', 42),
      createReq({ 'x-request-id': 'req-abc-123' }),
      res,
      next,
    );

    expect(res.statusCode).toBe(404);
    expect(res.body.requestId).toBe('req-abc-123');
  });

  it('omite requestId (não envia null) quando o header está ausente', () => {
    const res = createRes();
    errorHandler(new NotFoundError('Demanda'), createReq(), res, next);

    expect('requestId' in res.body).toBe(false);
  });

  it('converte ZodError em ValidationError com issues[]', () => {
    const res = createRes();
    const schema = z.object({ title: z.string() });
    const parsed = schema.safeParse({});
    const zodError = (parsed as { success: false; error: ZodError }).error;

    errorHandler(zodError, createReq(), res, next);

    expect(res.statusCode).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.issues.length).toBeGreaterThan(0);
  });

  it('emite header Retry-After para RateLimitError', () => {
    const res = createRes();
    errorHandler(new RateLimitError('slow down', 30), createReq(), res, next);

    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('30');
    expect(res.body.errorCode).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('loga exatamente uma vez por erro (sem duplicidade log-and-rethrow)', () => {
    const res = createRes();
    errorHandler(new AppError('boom', 500, 'INTERNAL_ERROR'), createReq(), res, next);

    const totalLogs =
      (logger.error as ReturnType<typeof vi.fn>).mock.calls.length +
      (logger.warn as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(totalLogs).toBe(1);
  });

  it('erros 4xx logam como warn, 5xx como error', () => {
    const res4 = createRes();
    errorHandler(new ValidationError('bad'), createReq(), res4, next);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const res5 = createRes();
    errorHandler(new AppError('boom'), createReq(), res5, next);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('H-8: masks raw error message for non-AppError 500s in any non-development env', () => {
    const scenarios = ['production', 'staging', 'test', ''];
    const originalEnv = process.env.NODE_ENV;
    for (const env of scenarios) {
      process.env.NODE_ENV = env;
      const res = createRes();
      const sensitiveError = new Error('ECONNREFUSED 127.0.0.1:5432 (db password: hunter2)');
      errorHandler(sensitiveError, createReq(), res, next);

      expect(res.statusCode).toBe(500);
      expect(res.body.message).toBe('Internal Server Error');
      expect(JSON.stringify(res.body)).not.toContain('hunter2');
      expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    }
    process.env.NODE_ENV = originalEnv;
  });

  it('H-8: preserves raw error message and stack for non-AppError 500s in development', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const res = createRes();
      const sensitiveError = new Error('ECONNREFUSED 127.0.0.1:5432 (db password: hunter2)');
      errorHandler(sensitiveError, createReq(), res, next);

      expect(res.statusCode).toBe(500);
      expect(res.body.message).toContain('ECONNREFUSED');
      expect(res.body).toHaveProperty('stack');
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('H-8: masks raw error message for non-AppError 500s in production', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = createRes();
      // A plain Error (not AppError) — simulates an unexpected crash
      const sensitiveError = new Error('ECONNREFUSED 127.0.0.1:5432 (db password: hunter2)');
      errorHandler(sensitiveError, createReq(), res, next);

      expect(res.statusCode).toBe(500);
      expect(res.body.message).toBe('Internal Server Error');
      expect(res.body.error).toBe('InternalServerError');
      // The raw message must NOT appear in the response
      expect(JSON.stringify(res.body)).not.toContain('hunter2');
      expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('H-8: preserves AppError messages in production (operational errors are safe)', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = createRes();
      errorHandler(new NotFoundError('Demanda', 42), createReq(), res, next);

      expect(res.statusCode).toBe(404);
      // NotFoundError is an AppError — its message is user-safe
      expect(res.body.message).toContain('Demanda');
      expect(res.body.message).toContain('42');
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});
