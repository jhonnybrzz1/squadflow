/**
 * Demanda #10358 T5 — `checkFreeTier`: intercepta `POST /api/refinements` e
 * `POST /api/git/auth/github/callback`, verifica contador vs limite antes da
 * operação e retorna 403 com mensagem clara quando o limite foi atingido.
 * Demanda #10364 T5 — gate respeita plano ativo (Pro = limites maiores).
 *
 * Requer que `requirePlatformAuth` já tenha rodado (usa `req.platformUser`).
 */
import type { NextFunction, Request, Response } from 'express';
import { asyncHandler, ForbiddenError } from './error-handler';
import { usageCounterService } from '../services/usage-counter-service';
import { gitConnectionService } from '../services/git-connection-service';
import { subscriptionService } from '../services/subscription-service';

export const FREE_TIER_UPGRADE_MESSAGE =
  'Você atingiu o limite do plano gratuito. Upgrade para continuar.';

export async function assertRefinementAllowed(userId: number): Promise<void> {
  const activePlan = await subscriptionService.getActivePlan(userId);
  const hasRemaining = await usageCounterService.hasRefinementsRemaining(userId, activePlan.plan);
  if (!hasRemaining) {
    throw new ForbiddenError(FREE_TIER_UPGRADE_MESSAGE);
  }
}

/**
 * Conectar/reconectar o MESMO provider (ex.: renovar token GitHub) nunca
 * conta contra o limite — só a PRIMEIRA conexão de um novo provider consome
 * uma vaga do Free Tier (ver plan.md e usage-counter-service.ts).
 */
export async function assertGitConnectAllowed(userId: number): Promise<void> {
  const alreadyConnected = await gitConnectionService.hasConnection(userId, 'github');
  if (alreadyConnected) return;
  const activePlan = await subscriptionService.getActivePlan(userId);
  const hasRemaining = await usageCounterService.hasRepoSlotRemaining(userId, activePlan.plan);
  if (!hasRemaining) {
    throw new ForbiddenError(FREE_TIER_UPGRADE_MESSAGE);
  }
}

export const checkFreeTierForRefinement = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    await assertRefinementAllowed(req.platformUser!.id);
    next();
  },
);

export const checkFreeTierForGitConnect = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    await assertGitConnectAllowed(req.platformUser!.id);
    next();
  },
);
