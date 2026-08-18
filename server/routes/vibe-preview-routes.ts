/**
 * Demanda #10366 T4/T6 — rotas de preview automático (Fatia 2C).
 *
 * POST /api/git/repos/:owner/:repo/preview — inicia job de preview (202)
 * GET /api/git/repos/:owner/:repo/preview/:jobId — consulta status do job
 *
 * Preview conta como 1 refinamento no Free Tier (T6).
 */
import { Router, Request, Response } from 'express';
import { asyncHandler, AppError } from '../middleware/error-handler';
import { requirePlatformAuth } from '../middleware/platform-auth';
import { rateLimitPlatformUser } from '../middleware/platform-rate-limits';
import { assertRefinementAllowed } from '../middleware/check-free-tier';
import { previewService } from '../services/preview-service';

const router = Router();

// T4: POST — inicia job de preview (202 Accepted)
router.post(
  '/api/git/repos/:owner/:repo/preview',
  requirePlatformAuth,
  rateLimitPlatformUser,
  asyncHandler(async (req: Request, res: Response) => {
    const { owner, repo } = req.params;
    if (!owner || !repo) {
      throw new AppError('owner e repo são obrigatórios.', 400, 'INVALID_PARAMS');
    }

    // T6: verifica limite de refinamento antes de processar
    await assertRefinementAllowed(req.platformUser!.id);

    const jobId = await previewService.createAndProcessJob(req.platformUser!.id, owner, repo);
    res.status(202).json({ jobId, status: 'pending' });
  }),
);

// T4: GET — consulta status do job (polling)
router.get(
  '/api/git/repos/:owner/:repo/preview/:jobId',
  requirePlatformAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { jobId } = req.params;
    if (!jobId) {
      throw new AppError('jobId é obrigatório.', 400, 'INVALID_PARAMS');
    }

    const jobStatus = await previewService.getJobStatus(jobId);
    res.status(200).json(jobStatus);
  }),
);

export default router;
