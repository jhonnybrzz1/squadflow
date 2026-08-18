/**
 * Safety Logs API Routes
 *
 * PRD endpoint: GET /api/safety/logs
 * Returns last 100 safety audit events (PII_REDACTED, PROMPT_INJECTION_DETECTED).
 * Protected by admin token authentication.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { safetyLogStore } from '../services/llm-guardrails';
import { logger } from '../utils/logger';
import { isValidToken } from '../utils/timing-safe-compare';
import { getUserContext } from '../middleware/auth-stub';
import { asyncHandler, ForbiddenError } from '../middleware/error-handler';

const router = Router();

// ============================================
// Auth middleware — SECURE IMPLEMENTATION
// ============================================

// SECURITY: audit-dev-token is NEVER accepted in any environment.
const AUDIT_TOKEN = process.env.LLM_AUDIT_TOKEN || '';

if (!process.env.LLM_AUDIT_TOKEN) {
  logger.warn('LLM_AUDIT_TOKEN not set - safety routes require JWT admin auth or env token');
}

function requireAdminAuth(req: Request, _res: Response, next: NextFunction): void {
  const token =
    (req.headers['x-audit-token'] as string) ||
    req.headers['authorization']?.replace('Bearer ', '');

  // SECURITY: Reject audit-dev-token in ALL environments
  if (token === 'audit-dev-token') {
    logger.warn('Rejected audit-dev-token', {
      context: { ip: req.ip, path: req.path, env: process.env.NODE_ENV, event: 'auth:failed' },
    });
    next(new ForbiddenError('Forbidden. audit-dev-token is permanently disabled.'));
    return;
  }

  // H-2: timing-safe comparison — `===` on secrets leaks matching prefix
  // length via short-circuit. Use crypto.timingSafeEqual via isValidToken.
  if (isValidToken(token, AUDIT_TOKEN)) {
    return next();
  }

  // Fallback: check for JWT admin role
  const userContext = getUserContext(req);
  if (process.env.NODE_ENV !== 'production' && userContext.role === 'admin') {
    return next();
  }

  next(new ForbiddenError('Forbidden. Admin access required.'));
}

router.use(requireAdminAuth);

// ============================================
// GET /api/safety/logs — Last 100 safety audit events
// ============================================

router.get(
  '/logs',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 100) : 100;
    const logs = await safetyLogStore.query(limit);
    res.json(logs);
  }),
);

export default router;
