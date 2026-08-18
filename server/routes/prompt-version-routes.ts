/**
 * Prompt Version & A/B Testing Routes
 *
 * API endpoints for managing prompt versions, activation/rollback,
 * A/B test configuration, and metrics aggregation.
 */

import { Router, type Request, type Response } from 'express';
import { promptVersionService } from '../services/prompt-version';
import { authContextMiddleware, secureAdminAuthMiddleware } from '../middleware/auth-stub';
import {
  asyncHandler,
  AppError,
  ValidationError,
  ConflictError,
} from '../middleware/error-handler';

const router = Router();

// Apply auth context middleware to all prompt routes
router.use(authContextMiddleware);

// ============================================
// GET /api/prompts/:name — List all versions for a prompt
// ============================================

router.get(
  '/:name',
  asyncHandler(async (req: Request, res: Response) => {
    const { name } = req.params;
    const versions = await promptVersionService.listVersions(name);
    const active = versions.find((v) => v.isActive) || null;

    res.json({
      promptName: name,
      activeVersion: active?.version || null,
      versions,
    });
  }),
);

// ============================================
// POST /api/prompts/:name/versions — Create a new version
// ============================================

router.post(
  '/:name/versions',
  secureAdminAuthMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const { name } = req.params;
    const { version, content, author, description } = req.body;

    if (!version || typeof version !== 'string') {
      throw new ValidationError('version is required (string)');
    }
    if (!content || typeof content !== 'string') {
      throw new ValidationError('content is required (string)');
    }

    const created = await promptVersionService.createVersion({
      promptName: name,
      version,
      content,
      author,
      description,
    });

    if (!created) {
      throw new ConflictError('Version already exists or creation failed');
    }

    res.status(201).json(created);
  }),
);

// ============================================
// POST /api/prompts/:name/activate — Activate a version
// ============================================

router.post(
  '/:name/activate',
  secureAdminAuthMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const { name } = req.params;
    const { version } = req.body;

    if (!version || typeof version !== 'string') {
      throw new ValidationError('version is required (string)');
    }

    // Verify version exists
    const existing = await promptVersionService.getVersion(name, version);
    if (!existing) {
      throw new AppError(`Version "${version}" not found for prompt "${name}"`, 404, 'NOT_FOUND');
    }

    const success = await promptVersionService.activateVersion(name, version);
    if (!success) {
      throw new AppError('Failed to activate version', 500, 'INTERNAL_ERROR');
    }

    res.json({ promptName: name, activatedVersion: version, success: true });
  }),
);

// ============================================
// POST /api/prompts/:name/ab-test — Create/update A/B test
// ============================================

router.post(
  '/:name/ab-test',
  secureAdminAuthMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const { name } = req.params;
    const { versionA, versionB, trafficPercentB } = req.body;

    if (!versionA || !versionB) {
      throw new ValidationError('versionA and versionB are required');
    }

    const percent = typeof trafficPercentB === 'number' ? trafficPercentB : 50;
    if (percent < 0 || percent > 100) {
      throw new ValidationError('trafficPercentB must be between 0 and 100');
    }

    const abTest = await promptVersionService.createABTest({
      promptName: name,
      versionA,
      versionB,
      trafficPercentB: percent,
    });

    if (!abTest) {
      throw new ValidationError('Failed to create A/B test. Ensure both versions exist.');
    }

    res.status(201).json(abTest);
  }),
);

// ============================================
// DELETE /api/prompts/:name/ab-test — End active A/B test
// ============================================

router.delete(
  '/:name/ab-test',
  secureAdminAuthMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const { name } = req.params;
    const success = await promptVersionService.endABTest(name);
    res.json({ promptName: name, ended: success });
  }),
);

// ============================================
// GET /api/prompts/:name/ab-test — Get active A/B test
// ============================================

router.get(
  '/:name/ab-test',
  asyncHandler(async (req: Request, res: Response) => {
    const { name } = req.params;
    const abTest = await promptVersionService.getActiveABTest(name);
    if (!abTest) {
      return res.json({ promptName: name, activeTest: null });
    }
    res.json({ promptName: name, activeTest: abTest });
  }),
);

// ============================================
// GET /api/prompts/:name/metrics — Aggregated metrics
// ============================================

router.get(
  '/:name/metrics',
  asyncHandler(async (req: Request, res: Response) => {
    const { name } = req.params;
    const sinceHours = req.query.hours ? Number(req.query.hours) : 24;
    const abTestId = req.query.abTestId ? Number(req.query.abTestId) : undefined;

    const metrics = await promptVersionService.getMetrics(name, { sinceHours, abTestId });
    res.json({
      promptName: name,
      periodHours: sinceHours,
      metrics,
    });
  }),
);

export default router;
