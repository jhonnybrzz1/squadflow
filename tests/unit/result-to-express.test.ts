import { describe, it, expect, vi } from 'vitest';
import { toNext, resultHandler, type Result } from '../../server/middleware/result-to-express';
import { AppError } from '../../server/middleware/error-handler';
import type { Response, NextFunction, Request } from 'express';

function makeRes(): Response {
  return {
    json: vi.fn(),
    status: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

function makeNext(): NextFunction {
  return vi.fn() as unknown as NextFunction;
}

describe('result-to-express', () => {
  it('toNext retorna true e serializa Result ok', () => {
    const res = makeRes();
    const next = makeNext();
    const result: Result<string> = { ok: true, data: 'hello' };

    const canProceed = toNext(result, res, next);
    expect(canProceed).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it('toNext chama next(AppError) quando Result ok é false', () => {
    const res = makeRes();
    const next = makeNext();
    const result: Result<string> = { ok: false, error: 'failed' };

    const canProceed = toNext(result, res, next, { defaultStatus: 422 });
    expect(canProceed).toBe(false);
    expect(next).toHaveBeenCalledOnce();
    const error = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(422);
    expect(error.message).toBe('failed');
  });

  it('toNext mapeia reason para status code customizado', () => {
    const res = makeRes();
    const next = makeNext();
    const result: Result<string> = { ok: false, reason: 'not_found' };

    toNext(result, res, next, {
      defaultStatus: 400,
      statusCodeForError: { not_found: 404 },
    });
    const error = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as AppError;
    expect(error.statusCode).toBe(404);
  });

  it('resultHandler serializa sucesso e propaga erro', async () => {
    const handler = resultHandler(async () => ({ ok: true, data: { id: 1 } }) as Result<unknown>);
    const res = makeRes();
    const next = makeNext();
    await handler({} as Request, res, next);
    expect(res.json).toHaveBeenCalledWith({ id: 1 });
    expect(next).not.toHaveBeenCalled();
  });
});
