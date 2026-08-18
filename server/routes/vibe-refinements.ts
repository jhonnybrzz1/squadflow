/**
 * Demanda #10358 T3 — fluxo principal de refinamento com IA (prompt livre).
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error-handler';
import { validateRequest } from '../middleware/validate-request';
import { requirePlatformAuth } from '../middleware/platform-auth';
import { checkFreeTierForRefinement } from '../middleware/check-free-tier';
import { rateLimitPlatformUser } from '../middleware/platform-rate-limits';
import { vibeRefinementService } from '../services/vibe-refinement-service';
import { usageCounterService } from '../services/usage-counter-service';
import { platformAnalyticsService } from '../services/platform-analytics-service';

const router = Router();

const refinementRequestSchema = z.object({
  body: z.object({
    prompt: z.string().min(1, 'prompt é obrigatório').max(4000),
    stack: z.string().max(200).optional(),
    projectType: z.string().max(200).optional(),
    repoContext: z.string().max(200).optional(),
    // Demanda #10365 T5 — conexão de banco opcional para enriquecer prompt
    dbConnectionId: z.number().int().positive().optional(),
  }),
});

router.post(
  '/api/refinements',
  requirePlatformAuth,
  rateLimitPlatformUser,
  checkFreeTierForRefinement,
  validateRequest(refinementRequestSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.platformUser!.id;
    const { prompt, stack, projectType, repoContext, dbConnectionId } = req.body as {
      prompt: string;
      stack?: string;
      projectType?: string;
      repoContext?: string;
      dbConnectionId?: number;
    };

    const result = await vibeRefinementService.refine({
      prompt,
      stack,
      projectType,
      repoContext,
      dbConnectionId,
      userId,
    });

    // Contador incrementado SÓ depois do sucesso (Tasks.md T5) e métrica de
    // ativação registrada só na primeira ocorrência (T3).
    await usageCounterService.incrementRefinements(userId);
    await platformAnalyticsService.logFirstRefinementOnce(userId);

    res.status(200).json(result);
  }),
);

export default router;
