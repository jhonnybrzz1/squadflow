/**
 * Demanda #10358 T5 — `GET /api/usage`: uso atual do Free Tier no mês.
 */
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/error-handler';
import { requirePlatformAuth } from '../middleware/platform-auth';
import { usageCounterService } from '../services/usage-counter-service';

const router = Router();

router.get(
  '/api/usage',
  requirePlatformAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const usage = await usageCounterService.getUsage(req.platformUser!.id);
    res.status(200).json(usage);
  }),
);

export default router;
