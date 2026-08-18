import { Response, NextFunction } from 'express';
import { AppError } from './error-handler';
import { logger } from '../utils/logger';

/**
 * Spec 10125 #16: padrão Result { ok, error, ... } para Express.
 *
 * Handlers que retornam Result objects (comum em ferramentas de agente e
 * serviços internos) podem usar `toNext()` para converter falhas em AppError
 * sem poluir o handler com `if (!result.ok) throw new AppError(...)`.
 */
export interface Result<T> {
  ok: boolean;
  data?: T;
  error?: string;
  reason?: string;
  errorCode?: string;
  statusCode?: number;
}

/**
 * Converte um Result { ok: false } em `next(new AppError(...))`.
 * Result { ok: true } é retornado para o handler serializar normalmente.
 *
 * Exemplo de uso em um handler:
 *
 *   const result = await someService.doThing();
 *   if (!toNext(result, res, next, { defaultStatus: 400 })) return;
 *   res.json(result.data);
 */
export function toNext<T>(
  result: Result<T>,
  res: Response,
  next: NextFunction,
  options: {
    defaultStatus?: number;
    defaultErrorCode?: string;
    operation?: string;
    statusCodeForError?: Record<string, number>;
  } = {},
): result is { ok: true; data: T } {
  const {
    defaultStatus = 400,
    defaultErrorCode = 'BAD_REQUEST',
    operation = 'result_to_express',
    statusCodeForError,
  } = options;

  if (result.ok) {
    return true;
  }

  const reason = result.reason ?? result.error ?? 'unknown';
  const statusCode = result.statusCode ?? statusCodeForError?.[reason] ?? defaultStatus;
  const errorCode = result.errorCode ?? defaultErrorCode;
  const message = result.error ?? result.reason ?? 'Operação falhou';

  logger.warn('[result-to-express] Resultado de falha convertido para erro HTTP', {
    context: { operation, statusCode, errorCode, message },
  });

  next(new AppError(message, statusCode, errorCode));
  return false;
}

/**
 * Wrapper que permite que um handler async retorne um Result e a resposta
 * seja serializada automaticamente quando ok, ou propagada como erro quando
 * falhar. Útil para migração incremental de handlers existentes.
 *
 * Exemplo:
 *
 *   router.post('/foo', asyncHandler(resultHandler(async (req) => myService.foo(req.body))));
 */
export function resultHandler<T>(
  fn: (req: Parameters<import('express').RequestHandler>[0]) => Promise<Result<T>>,
) {
  return async (
    req: Parameters<import('express').RequestHandler>[0],
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const result = await fn(req);
      if (!toNext(result, res, next)) return;
      res.json(result.data);
    } catch (error) {
      next(error);
    }
  };
}
