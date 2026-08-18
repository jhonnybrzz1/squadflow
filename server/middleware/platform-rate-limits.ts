/**
 * Demanda #10358 T2/T3 — instâncias de rate limit da plataforma pública.
 *
 * Duas janelas, como pedido no PRD/Tasks: uma por IP (proteção básica contra
 * burst/DDoS nos endpoints de auth) e outra por usuário autenticado (protege
 * o endpoint de refinamento, que dispara chamadas de IA). Reaproveita a
 * factory genérica em vez de adicionar `express-rate-limit` como dependência
 * nova (ver plan.md).
 */
import type { Request } from 'express';
import { createIpRateLimiter, createSlidingWindowLimiter } from './sliding-window-rate-limit';

const MINUTE_MS = 60_000;

/** 10 req/min por IP — endpoints de auth (signup/login/logout). */
export const rateLimitPlatformAuthByIp = createIpRateLimiter('platform-auth-ip', MINUTE_MS, 10);

/**
 * 10 req/min por usuário autenticado — endpoint de refinamento (T3). Deve ser
 * montado DEPOIS de `requirePlatformAuth` na cadeia de middlewares: a chave
 * depende de `req.platformUser` já estar preenchido.
 */
export const rateLimitPlatformUser = createSlidingWindowLimiter({
  windowMs: MINUTE_MS,
  max: 10,
  keyPrefix: 'platform-user',
  keyFn: (req: Request) => String(req.platformUser?.id ?? 'anonymous'),
});
