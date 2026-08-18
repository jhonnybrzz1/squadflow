/**
 * Lightweight in-memory rate limiter (H-3).
 *
 * No external dependency — uses a sliding-window counter per IP bucket.
 * Suitable for a single-process local app like AiChatFlow1. For multi-
 * instance deployments, replace the Map with Redis.
 *
 * Configurable via env vars:
 *   RATE_LIMIT_WINDOW_MS (default 60_000) — window size
 *   RATE_LIMIT_MAX (default 30)            — max requests per window per IP
 *
 * Returns 429 Too Many Requests with Retry-After header when exceeded.
 */
import type { Request, Response, NextFunction } from 'express';

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX || '30', 10);

function getWindowMs(): number {
  // Read env on each call so tests can override without module reload.
  // Falls back to the module-level constant for performance in prod.
  const v = process.env.RATE_LIMIT_WINDOW_MS;
  return v ? parseInt(v, 10) : WINDOW_MS;
}

function getMaxRequests(): number {
  const v = process.env.RATE_LIMIT_MAX;
  return v ? parseInt(v, 10) : MAX_REQUESTS;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Periodic cleanup of expired buckets to prevent unbounded memory growth.
// Runs every window period; entries older than 2× window are evicted.
let lastCleanup = Date.now();
function cleanupIfNeeded(now: number, windowMs: number): void {
  if (now - lastCleanup < windowMs) return;
  lastCleanup = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}

/**
 * Rate limiter middleware for LLM-triggering endpoints. Limits per-IP
 * request count within a sliding window.
 */
export function rateLimitLLM(req: Request, res: Response, next: NextFunction): void {
  // Read-only / preflight requests should not consume the LLM-triggering quota.
  // The UI polls GET endpoints (e.g. /api/demands, /api/demands/:id/messages)
  // every 1-3s; counting them against the same bucket causes false 429s.
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }

  const now = Date.now();
  const windowMs = getWindowMs();
  const maxRequests = getMaxRequests();
  cleanupIfNeeded(now, windowMs);

  // Use x-forwarded-for if present (behind proxy), otherwise req.ip.
  const ip =
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
  const key = `llm:${ip}`;

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    next();
    return;
  }

  bucket.count++;
  if (bucket.count > maxRequests) {
    const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
    res.set('Retry-After', String(retryAfterSec));
    res.status(429).json({
      error: 'Too Many Requests',
      retryAfterSec,
      message: `Rate limit exceeded: max ${maxRequests} requests per ${windowMs / 1000}s per IP.`,
    });
    return;
  }

  next();
}
