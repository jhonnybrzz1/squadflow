import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { rateLimitLLM } from '../../server/middleware/rate-limiter';

// H-3: rate limiter test. Uses the default limits (30 per 60s) and makes
// 31 requests to trigger 429. Each test uses a unique IP to avoid cross-
// test bucket contamination.

function makeReq(ip = '127.0.0.1', forwarded?: string): Partial<Request> {
  return {
    ip,
    headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
  };
}

function makeRes() {
  const state = { status: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  const res: Partial<Response> = {
    set: vi.fn((k: string, v: string) => {
      state.headers[k] = v;
      return res as Response;
    }),
    status: vi.fn((code: number) => {
      state.status = code;
      return res as Response;
    }),
    json: vi.fn((b: unknown) => {
      state.body = b;
      return res as Response;
    }),
  };
  return { res: res as Response, state };
}

describe('rate-limiter (H-3)', () => {
  it('allows requests up to the default limit (30)', () => {
    const ip = `test-allows-${Date.now()}-${Math.random()}`;
    for (let i = 0; i < 30; i++) {
      const { res } = makeRes();
      const next = vi.fn();
      rateLimitLLM(makeReq(ip) as Request, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it('returns 429 when limit exceeded (31st request)', () => {
    const ip = `test-429-${Date.now()}-${Math.random()}`;
    // Fill the bucket with 30 allowed requests
    for (let i = 0; i < 30; i++) {
      const { res } = makeRes();
      rateLimitLLM(makeReq(ip) as Request, res, vi.fn());
    }
    // 31st should be blocked
    const { res, state } = makeRes();
    const next = vi.fn();
    rateLimitLLM(makeReq(ip) as Request, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(state.status).toBe(429);
    expect(state.headers['Retry-After']).toBeDefined();
    expect((state.body as { error: string }).error).toBe('Too Many Requests');
  });

  it('tracks IPs independently', () => {
    const ip1 = `test-ind-1-${Date.now()}-${Math.random()}`;
    for (let i = 0; i < 30; i++) {
      const { res } = makeRes();
      rateLimitLLM(makeReq(ip1) as Request, res, vi.fn());
    }
    // Different IP should still be allowed
    const ip2 = `test-ind-2-${Date.now()}-${Math.random()}`;
    const { res } = makeRes();
    const next = vi.fn();
    rateLimitLLM(makeReq(ip2) as Request, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('uses x-forwarded-for when present', () => {
    const forwarded = `test-xff-${Date.now()}-${Math.random()}`;
    // 30 requests from forwarded IP
    for (let i = 0; i < 30; i++) {
      const { res } = makeRes();
      rateLimitLLM(makeReq('9.9.9.9', forwarded) as Request, res, vi.fn());
    }
    // 31st from same forwarded IP (different req.ip) should be blocked
    const { res, state } = makeRes();
    rateLimitLLM(makeReq('8.8.8.8', forwarded) as Request, res, vi.fn());
    expect(state.status).toBe(429);
  });
});
