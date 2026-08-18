/**
 * Public, read-only API for listing available model aliases.
 *
 * Used by the frontend to populate model selection dropdowns with stable
 * aliases instead of hardcoded concrete model ids. No authentication required
 * — this only exposes alias names and their families, not secrets or
 * internal state.
 */

import { Router, Request, Response } from 'express';
import { modelRegistry } from '../services/model-registry';
import { asyncHandler } from '../middleware/error-handler';

const router = Router();

router.get(
  '/model-names',
  asyncHandler(async (_req: Request, res: Response) => {
    const aliases = await modelRegistry.listAliases();
    // Only expose active aliases to the frontend
    const publicAliases = aliases
      .filter((a) => a.status === 'active')
      .map((a) => ({
        alias: a.alias,
        family: a.family,
        provider: a.provider,
        activeModelId: a.activeModelId,
      }));
    res.json({ models: publicAliases });
  }),
);

export default router;
