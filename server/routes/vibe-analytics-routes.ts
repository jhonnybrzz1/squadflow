/**
 * Demanda #10358 T3 — registra a abertura da plataforma para a métrica de
 * ativação (tempo entre abrir a plataforma e receber o primeiro refinamento).
 */
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/error-handler';
import { requirePlatformAuth } from '../middleware/platform-auth';
import { platformAnalyticsService } from '../services/platform-analytics-service';

const router = Router();

router.post(
  '/api/analytics/platform-opened',
  requirePlatformAuth,
  asyncHandler(async (req: Request, res: Response) => {
    await platformAnalyticsService.logPlatformOpenedOnce(req.platformUser!.id);
    res.status(202).json({ ok: true });
  }),
);

export default router;
