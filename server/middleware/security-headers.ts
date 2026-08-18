/**
 * Security headers middleware (H-4).
 *
 * Adds standard security headers to all responses:
 * - X-Content-Type-Options: nosniff — prevents MIME-type sniffing
 * - X-Frame-Options: DENY — prevents clickjacking via iframe embedding
 * - Strict-Transport-Security — enforces HTTPS (only when served over HTTPS)
 * - Referrer-Policy: strict-origin-when-cross-origin — limits referrer leakage
 * - X-XSS-Protection: 0 — disables legacy IE XSS auditor (caused more issues
 *   than it fixed; modern browsers use CSP instead)
 * - Content-Security-Policy — restricts resource loading to self + inline
 *   (needed for Vite dev server injected scripts; tightened in production)
 *
 * No helmet dependency — hand-rolled to keep the dependency tree lean.
 */
import type { Request, Response, NextFunction } from 'express';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// CSP: allow 'self' for everything. In dev, Vite injects inline scripts
// and styles with nonces it doesn't expose to us, so we allow 'unsafe-inline'
// for scripts/styles in dev only. In production, tighten to self only.
const CSP_DEV =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://replit.com; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data: https://fonts.gstatic.com; " +
  "connect-src 'self' ws: wss: https://replit.com; " +
  "frame-ancestors 'none'";

const CSP_PROD =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data: https://fonts.gstatic.com; " +
  "connect-src 'self'; " +
  "frame-ancestors 'none'";

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Content-Security-Policy', IS_PRODUCTION ? CSP_PROD : CSP_DEV);

  // HSTS only over HTTPS — sending it over HTTP would cache an insecure
  // state. Respect the request protocol, not just NODE_ENV.
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}
