import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  winstonCreateLogger: vi.fn().mockReturnValue({
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    level: 'info',
  }),
  infoSpy: vi.fn(),
  errorSpy: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('winston', () => ({
  default: {
    createLogger: mocks.winstonCreateLogger,
    format: {
      combine: vi.fn().mockReturnValue({}),
      timestamp: vi.fn().mockReturnValue({}),
      errors: vi.fn().mockReturnValue({}),
      splat: vi.fn().mockReturnValue({}),
      json: vi.fn().mockReturnValue({}),
      colorize: vi.fn().mockReturnValue({}),
      printf: vi.fn().mockReturnValue({}),
    },
    transports: {
      Console: vi.fn(),
      File: vi.fn(),
    },
    config: {
      npm: { levels: { error: 0, warn: 1, info: 2, debug: 3, verbose: 4 } },
    },
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn().mockReturnValue(true),
      mkdirSync: vi.fn(),
    },
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
  };
});

import { createLogger, traceIdMiddleware, logger } from '../../server/utils/logger';
import type { Request, Response } from 'express';

describe('B-1: createLogger e traceIdMiddleware', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(logger, 'info').mockImplementation(mocks.infoSpy);
    vi.spyOn(logger, 'error').mockImplementation(mocks.errorSpy);
    vi.spyOn(logger, 'warn').mockImplementation(mocks.warnSpy);
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.NODE_ENV = originalEnv;
  });

  it('lança em desenvolvimento quando req é omitido', () => {
    expect(() => createLogger()).toThrow(
      'B-1: createLogger(req) exige um objeto Request em desenvolvimento.',
    );
  });

  it('não lança em produção quando req é omitido', () => {
    process.env.NODE_ENV = 'production';
    const log = createLogger();
    expect(log.traceId).toBeDefined();
    expect(typeof log.traceId).toBe('string');
  });

  it('reutiliza req.traceId quando presente', () => {
    const req = { traceId: 'existing-trace-id' } as unknown as Request;
    const log = createLogger(req);
    expect(log.traceId).toBe('existing-trace-id');
  });

  it('gera traceId quando req não possui traceId', () => {
    const req = {} as unknown as Request;
    const log = createLogger(req);
    expect(log.traceId).toBeDefined();
    expect(typeof log.traceId).toBe('string');
  });

  it('loga com schema estruturado obrigatório', () => {
    const req = { traceId: 'trace-123' } as unknown as Request;
    const log = createLogger(req);
    log.info('mensagem de teste', { context: { foo: 'bar' } });

    expect(mocks.infoSpy).toHaveBeenCalledWith('mensagem de teste', {
      level: 'info',
      timestamp: expect.any(String),
      message: 'mensagem de teste',
      service: 'AIChatFlow',
      traceId: 'trace-123',
      context: { foo: 'bar' },
    });
  });

  it('inclui stack em logs de erro', () => {
    const req = { traceId: 'trace-456' } as unknown as Request;
    const error = new Error('boom');
    const log = createLogger(req);
    log.error('falha', { context: { step: 'test' }, error });

    const callArgs = mocks.errorSpy.mock.calls[0];
    const secondArg = callArgs[1] as Record<string, unknown>;
    expect(secondArg).toMatchObject({
      level: 'error',
      message: 'falha',
      traceId: 'trace-456',
      context: { step: 'test' },
    });
    expect(secondArg.stack).toContain('Error: boom');
    expect(secondArg.error).toEqual({ name: 'Error', message: 'boom' });
  });

  it('traceIdMiddleware injeta traceId no req', () => {
    const req = { get: vi.fn().mockReturnValue(undefined) } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn();

    traceIdMiddleware(req, res, next);

    expect(req.traceId).toBeDefined();
    expect(typeof req.traceId).toBe('string');
    expect(next).toHaveBeenCalled();
  });

  it('traceIdMiddleware respeita X-Request-Id', () => {
    const req = {
      get: vi.fn().mockReturnValue('incoming-request-id'),
    } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn();

    traceIdMiddleware(req, res, next);

    expect(req.traceId).toBe('incoming-request-id');
    expect(next).toHaveBeenCalled();
  });

  it('traceIdMiddleware preserva traceId existente', () => {
    const req = { traceId: 'existing-trace', get: vi.fn() } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn();

    traceIdMiddleware(req, res, next);

    expect(req.traceId).toBe('existing-trace');
    expect(next).toHaveBeenCalled();
  });
});
