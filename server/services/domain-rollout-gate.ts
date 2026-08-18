import type { DemandDomain } from '@shared/schema';

export const DOMAIN_ROLLOUT_MIN_REAL_DEMANDS = 5;

export type DomainRolloutGateStatus =
  | 'blocked_insufficient_cases'
  | 'pending_human_value_review'
  | 'go';

export interface DomainRolloutGateResult {
  domain: DemandDomain;
  status: DomainRolloutGateStatus;
  observedRealDemands: number;
  requiredRealDemands: number;
  humanValueConfirmed: boolean;
  reason: string;
}

export function evaluateDomainRolloutGate(input: {
  domain: DemandDomain;
  observedRealDemands: number;
  humanValueConfirmed: boolean;
}): DomainRolloutGateResult {
  const observedRealDemands = Math.max(0, Math.floor(input.observedRealDemands));
  if (observedRealDemands < DOMAIN_ROLLOUT_MIN_REAL_DEMANDS) {
    return {
      ...input,
      observedRealDemands,
      requiredRealDemands: DOMAIN_ROLLOUT_MIN_REAL_DEMANDS,
      status: 'blocked_insufficient_cases',
      reason: `Rollout bloqueado: ${observedRealDemands}/${DOMAIN_ROLLOUT_MIN_REAL_DEMANDS} demandas reais observadas.`,
    };
  }

  if (!input.humanValueConfirmed) {
    return {
      ...input,
      observedRealDemands,
      requiredRealDemands: DOMAIN_ROLLOUT_MIN_REAL_DEMANDS,
      status: 'pending_human_value_review',
      reason: 'Amostra mínima atingida; valor ainda depende de confirmação humana documentada.',
    };
  }

  return {
    ...input,
    observedRealDemands,
    requiredRealDemands: DOMAIN_ROLLOUT_MIN_REAL_DEMANDS,
    status: 'go',
    reason: 'Amostra mínima e confirmação humana de valor registradas.',
  };
}
