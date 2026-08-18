/**
 * Demanda #10358 — factory de rate limiter sliding-window em memória,
 * generalizando o padrão de `server/middleware/rate-limiter.ts` (sem
 * dependência externa) para permitir chaves além de IP (ex.: usuário
 * autenticado da plataforma pública).
 */
import type { Request, Response, NextFunction } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

export interface SlidingWindowLimiterOptions {
  /** Tamanho da janela em ms. */
  windowMs: number;
  /** Máximo de requisições por janela. */
  max: number;
  /** Prefixo para namespacing das chaves (evita colisão entre limiters). */
  keyPrefix: string;
  /** Deriva a chave de rate-limit (IP, id de usuário, etc.) da requisição. */
  keyFn: (req: Request) => string;
}

export function createSlidingWindowLimiter(options: SlidingWindowLimiterOptions) {
  const buckets = new Map<string, Bucket>();
  let lastCleanup = Date.now();

  function cleanupIfNeeded(now: number): void {
    if (now - lastCleanup < options.windowMs) return;
    lastCleanup = now;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt < now) buckets.delete(key);
    }
  }

  return function slidingWindowLimiter(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    cleanupIfNeeded(now);
    const key = `${options.keyPrefix}:${options.keyFn(req)}`;

    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    bucket.count++;
    if (bucket.count > options.max) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: 'Too Many Requests',
        retryAfterSec,
        message: `Rate limit exceeded: max ${options.max} requests per ${options.windowMs / 1000}s.`,
      });
      return;
    }
    next();
  };
}

/** Extrai o IP do cliente, preferindo `x-forwarded-for` quando atrás de proxy. */
export function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
}

export function createIpRateLimiter(keyPrefix: string, windowMs: number, max: number) {
  return createSlidingWindowLimiter({ windowMs, max, keyPrefix, keyFn: clientIp });
}
