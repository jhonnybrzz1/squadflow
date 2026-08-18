import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { securityHeaders } from '../../server/middleware/security-headers';

function makeRes() {
  const headers: Record<string, string> = {};
  const res: Partial<Response> = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
      return res as Response;
    }),
  };
  return { res: res as Response, headers };
}

function makeReq(opts: { secure?: boolean; forwardedProto?: string } = {}): Request {
  return {
    secure: opts.secure ?? false,
    headers: opts.forwardedProto ? { 'x-forwarded-proto': opts.forwardedProto } : {},
  } as unknown as Request;
}

describe('security-headers (H-4)', () => {
  it('sets X-Content-Type-Options nosniff', () => {
    const { res, headers } = makeRes();
    securityHeaders(makeReq(), res, vi.fn());
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('sets X-Frame-Options DENY', () => {
    const { res, headers } = makeRes();
    securityHeaders(makeReq(), res, vi.fn());
    expect(headers['X-Frame-Options']).toBe('DENY');
  });

  it('sets Referrer-Policy', () => {
    const { res, headers } = makeRes();
    securityHeaders(makeReq(), res, vi.fn());
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });

  it('sets Content-Security-Policy', () => {
    const { res, headers } = makeRes();
    securityHeaders(makeReq(), res, vi.fn());
    expect(headers['Content-Security-Policy']).toBeDefined();
    expect(headers['Content-Security-Policy']).toContain("default-src 'self'");
  });

  it('sets HSTS when req.secure is true', () => {
    const { res, headers } = makeRes();
    securityHeaders(makeReq({ secure: true }), res, vi.fn());
    expect(headers['Strict-Transport-Security']).toContain('max-age=31536000');
  });

  it('sets HSTS via x-forwarded-proto https', () => {
    const { res, headers } = makeRes();
    securityHeaders(makeReq({ forwardedProto: 'https' }), res, vi.fn());
    expect(headers['Strict-Transport-Security']).toContain('max-age=31536000');
  });

  it('does NOT set HSTS over HTTP', () => {
    const { res, headers } = makeRes();
    securityHeaders(makeReq(), res, vi.fn());
    expect(headers['Strict-Transport-Security']).toBeUndefined();
  });

  it('calls next()', () => {
    const { res } = makeRes();
    const next = vi.fn();
    securityHeaders(makeReq(), res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
