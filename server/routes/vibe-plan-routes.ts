/**
 * Demanda #10364 T3 — `GET /api/me/plan`: plano ativo e limites do usuário.
 *
 * Protegido por `requirePlatformAuth` (security_specialist: endpoint deve
 * ter auth obrigatória, igual ao checkProPlan). Retorna:
 * `{ plan, limits: { refinements: { used, max }, gitRepos: { used, max },
 *   hasFullHistory }, currentPeriodEnd }`
 *
 * Frontend usa apenas para UX — o backend é a fonte de verdade (security).
 */
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/error-handler';
import { requirePlatformAuth } from '../middleware/platform-auth';
import { subscriptionService } from '../services/subscription-service';
import { usageCounterService } from '../services/usage-counter-service';
import { gitConnectionService } from '../services/git-connection-service';

const router = Router();

router.get(
  '/api/me/plan',
  requirePlatformAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.platformUser!.id;
    const activePlan = await subscriptionService.getActivePlan(userId);
    const usage = await usageCounterService.getUsage(userId, activePlan.plan);

    // Conta repos conectados atuais (não do contador mensal, mas reais)
    const connectedRepos = await gitConnectionService.countConnections(userId);

    res.status(200).json({
      plan: activePlan.plan,
      status: activePlan.status,
      currentPeriodEnd: activePlan.currentPeriodEnd,
      cancelAtPeriodEnd: activePlan.cancelAtPeriodEnd,
      limits: {
        refinements: {
          used: usage.refinementsUsed,
          max: usage.refinementsLimit,
        },
        gitRepos: {
          used: connectedRepos,
          // -1 = ilimitado (Pro)
          max: usage.reposLimit,
        },
        hasFullHistory: usage.hasFullHistory,
      },
    });
  }),
);

export default router;
