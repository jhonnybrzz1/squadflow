/**
 * Demanda #10364 T3 — middleware `checkProPlan` (Fatia 2A).
 *
 * Verifica se o usuário tem plano Pro ativo (incluindo grace period).
 * Requer que `requirePlatformAuth` já tenha rodado (usa `req.platformUser`).
 * Retorna 403 com `{ error, upgradeUrl }` quando o plano é Free.
 *
 * NÃO substitui `checkFreeTier` — este é estendido para consultar o plano
 * ativo. `checkProPlan` é usado para features exclusivas do Pro (ex: histórico
 * completo).
 */
import type { NextFunction, Request, Response } from 'express';
import { asyncHandler, ForbiddenError } from './error-handler';
import { subscriptionService } from '../services/subscription-service';

export const PRO_PLAN_REQUIRED_MESSAGE = 'Plano Pro necessário para acessar este recurso.';
export const UPGRADE_URL = '/vibe/upgrade';

/** Exige plano Pro ativo. Para features exclusivas do Pro. */
export const checkProPlan = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const activePlan = await subscriptionService.getActivePlan(req.platformUser!.id);
    if (activePlan.plan !== 'pro') {
      const err = new ForbiddenError(PRO_PLAN_REQUIRED_MESSAGE);
      (err as unknown as { upgradeUrl?: string }).upgradeUrl = UPGRADE_URL;
      throw err;
    }
    next();
  },
);

/**
 * Helper para o checkFreeTier estendido: retorna o plano ativo do usuário
 * para que o gate de refinamento/Git respeite Pro (limites maiores).
 */
export async function getActivePlanForUser(userId: number) {
  return subscriptionService.getActivePlan(userId);
}
