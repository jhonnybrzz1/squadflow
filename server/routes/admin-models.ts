/**
 * Admin API routes for the Model Registry subsystem.
 *
 * Exposes:
 *  - GET  /api/admin/models/aliases           — list all aliases
 *  - GET  /api/admin/models/aliases/:alias     — get a single alias
 *  - POST /api/admin/models/resolve            — resolve an alias or id
 *  - POST /api/admin/models/invalidate         — invalidate cache
 *  - GET  /api/admin/models/candidates         — list candidates
 *  - POST /api/admin/models/promote             — promote a candidate
 *  - POST /api/admin/models/reject              — reject a candidate
 *  - POST /api/admin/models/rollback            — rollback an alias
 *  - GET  /api/admin/models/history             — list promotion history
 *  - POST /api/admin/models/discover            — trigger a discovery cycle
 *
 * All routes are protected by adminAuthMiddleware (applied in admin.ts).
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middleware/validate-request';
import { modelRegistry } from '../services/model-registry';
import { modelDiscovery } from '../services/model-discovery';
import { modelPromoter } from '../services/model-promoter';
import { asyncHandler, AppError } from '../middleware/error-handler';

const router = Router();

// ── Aliases ────────────────────────────────────────────────────────────────

router.get(
  '/aliases',
  asyncHandler(async (_req: Request, res: Response) => {
    const aliases = await modelRegistry.listAliases();
    res.json({ aliases });
  }),
);

const getAliasSchema = z.object({
  params: z.object({ alias: z.string().min(1) }),
});

router.get(
  '/aliases/:alias',
  validateRequest(getAliasSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { alias } = req.params as { alias: string };
    const aliases = await modelRegistry.listAliases();
    const found = aliases.find((a) => a.alias === alias);
    if (!found) {
      throw new AppError('Alias not found', 404, 'NOT_FOUND');
    }
    res.json({ alias: found });
  }),
);

// ── Resolve ────────────────────────────────────────────────────────────────

const resolveSchema = z.object({
  body: z.object({
    aliasOrModelId: z.string().min(1),
  }),
});

router.post(
  '/resolve',
  validateRequest(resolveSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { aliasOrModelId } = req.body as { aliasOrModelId: string };
    let resolved;
    try {
      resolved = await modelRegistry.resolve(aliasOrModelId);
    } catch (error) {
      if (error instanceof Error && error.name === 'UnknownModelAliasError') {
        throw new AppError('Unknown alias or model id', 404, 'NOT_FOUND', {
          aliasOrModelId: req.body.aliasOrModelId,
        });
      }
      throw error;
    }
    res.json({ resolved });
  }),
);

// ── Invalidate cache ────────────────────────────────────────────────────────

const invalidateSchema = z.object({
  body: z.object({
    alias: z.string().optional(),
  }),
});

router.post(
  '/invalidate',
  validateRequest(invalidateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { alias } = (req.body as { alias?: string }) ?? {};
    await modelRegistry.invalidate(alias);
    res.json({ success: true, invalidated: alias ?? 'all' });
  }),
);

// ── Candidates ──────────────────────────────────────────────────────────────

const listCandidatesSchema = z.object({
  query: z.object({
    alias: z.string().optional(),
    status: z.string().optional(),
  }),
});

router.get(
  '/candidates',
  validateRequest(listCandidatesSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as { alias?: string; status?: string };
    const candidates = await modelDiscovery.listCandidates({
      alias: query.alias,
      status: query.status,
    });
    res.json({ candidates });
  }),
);

// ── Validate / Promote / Reject / Rollback ──────────────────────────────────

// MR-03: Validation is a separate step from promotion. A discovered candidate
// must be validated (smoke-tested) before it can be promoted.
const validateSchema = z.object({
  body: z
    .object({
      alias: z.string().min(1).max(200),
      candidateId: z.number().int().positive(),
      triggeredBy: z.string().max(200).optional(),
    })
    .strict(),
});

router.post(
  '/validate',
  validateRequest(validateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as {
      alias: string;
      candidateId: number;
      triggeredBy?: string;
    };
    const result = await modelPromoter.validate({
      alias: body.alias,
      candidateId: body.candidateId,
      triggeredBy: body.triggeredBy ?? 'admin-api',
    });
    // Resultado de domínio estruturado (não erro ad hoc): contrato preservado (FR-011)
    res.status(result.success ? 200 : 400).json(result);
  }),
);

// Note: `skipSmokeTest` is intentionally NOT accepted from the client (HIGH-01).
// The smoke test is mandatory over the API so a discovered candidate can never
// be promoted to active without proving it responds. Bypassing validation is an
// internal-only affordance (tests/seed), not an HTTP-exposed option.
// MR-03: `promote` now requires the candidate to already be `validated`.
// Call `/validate` first to run the smoke test and mark the candidate.
const promoteSchema = z.object({
  body: z
    .object({
      alias: z.string().min(1).max(200),
      candidateId: z.number().int().positive(),
      triggeredBy: z.string().max(200).optional(),
      reason: z.string().max(1000).optional(),
    })
    .strict(),
});

router.post(
  '/promote',
  validateRequest(promoteSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as {
      alias: string;
      candidateId: number;
      triggeredBy?: string;
      reason?: string;
    };
    const result = await modelPromoter.promote({
      alias: body.alias,
      candidateId: body.candidateId,
      triggeredBy: body.triggeredBy ?? 'admin-api',
      reason: body.reason,
    });
    // Resultado de domínio estruturado (não erro ad hoc): contrato preservado (FR-011)
    res.status(result.success ? 200 : 400).json(result);
  }),
);

const rejectSchema = z.object({
  body: z.object({
    alias: z.string().min(1),
    candidateId: z.number().int().positive(),
    triggeredBy: z.string().optional(),
    reason: z.string().optional(),
  }),
});

router.post(
  '/reject',
  validateRequest(rejectSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as {
      alias: string;
      candidateId: number;
      triggeredBy?: string;
      reason?: string;
    };
    const result = await modelPromoter.reject(
      body.alias,
      body.candidateId,
      body.triggeredBy ?? 'admin-api',
      body.reason,
    );
    // Resultado de domínio estruturado (não erro ad hoc): contrato preservado (FR-011)
    res.status(result.success ? 200 : 400).json(result);
  }),
);

const rollbackSchema = z.object({
  body: z.object({
    alias: z.string().min(1),
    triggeredBy: z.string().optional(),
    reason: z.string().optional(),
  }),
});

router.post(
  '/rollback',
  validateRequest(rollbackSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { alias: string; triggeredBy?: string; reason?: string };
    const result = await modelPromoter.rollback({
      alias: body.alias,
      triggeredBy: body.triggeredBy ?? 'admin-api',
      reason: body.reason,
    });
    // Resultado de domínio estruturado (não erro ad hoc): contrato preservado (FR-011)
    res.status(result.success ? 200 : 400).json(result);
  }),
);

// ── History ─────────────────────────────────────────────────────────────────

const historySchema = z.object({
  query: z.object({
    alias: z.string().optional(),
  }),
});

router.get(
  '/history',
  validateRequest(historySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { alias } = req.query as { alias?: string };
    const history = await modelPromoter.listHistory(alias);
    res.json({ history });
  }),
);

// ── Discover (manual trigger) ───────────────────────────────────────────────

router.post(
  '/discover',
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await modelDiscovery.runCycle();
    res.json(result);
  }),
);

export default router;
