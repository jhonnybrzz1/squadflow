/**
 * Demanda #10358 T5 — limites do Free Tier (Fatia 1).
 * Demanda #10364 T1 — limites do Pro Tier (Fatia 2A).
 *
 * Números vêm do PRD/Tasks.md (consenso tech_lead/product_owner/product_manager
 * na Rodada 2, "Notas de Implementação"), não inventados aqui. Configuráveis
 * por env var seguindo a convenção do resto do repo (ex.: RATE_LIMIT_MAX).
 */
export interface TierLimits {
  maxRefinementsPerMonth: number;
  maxConnectedRepos: number;
  hasFullHistory: boolean;
}

export type PlanType = 'free' | 'pro';

export function getFreeTierLimits(): TierLimits {
  return {
    maxRefinementsPerMonth: parseInt(process.env.FREE_TIER_MAX_REFINEMENTS_PER_MONTH || '3', 10),
    maxConnectedRepos: parseInt(process.env.FREE_TIER_MAX_CONNECTED_REPOS || '1', 10),
    hasFullHistory: false,
  };
}

export function getProTierLimits(): TierLimits {
  return {
    maxRefinementsPerMonth: parseInt(process.env.PRO_TIER_MAX_REFINEMENTS_PER_MONTH || '30', 10),
    // 0 = ilimitado (convention: 0 means unlimited)
    maxConnectedRepos: parseInt(process.env.PRO_TIER_MAX_CONNECTED_REPOS || '0', 10),
    hasFullHistory: true,
  };
}

export function getTierLimits(plan: PlanType): TierLimits {
  return plan === 'pro' ? getProTierLimits() : getFreeTierLimits();
}

/** Período corrente no formato `YYYY-MM`, usado como chave de `usage_counters`. */
export function currentPeriod(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}
