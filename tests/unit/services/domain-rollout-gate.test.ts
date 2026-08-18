import { describe, expect, it } from 'vitest';
import {
  evaluateDomainRolloutGate,
  DOMAIN_ROLLOUT_MIN_REAL_DEMANDS,
} from '../../../server/services/domain-rollout-gate';

describe('gate de rollout de domínio especializado', () => {
  it('bloqueia antes das 5 demandas reais', () => {
    expect(
      evaluateDomainRolloutGate({
        domain: 'legaltech_lgpd',
        observedRealDemands: 4,
        humanValueConfirmed: true,
      }).status,
    ).toBe('blocked_insufficient_cases');
  });

  it('não converte contagem em valor sem confirmação humana', () => {
    const result = evaluateDomainRolloutGate({
      domain: 'legaltech_lgpd',
      observedRealDemands: DOMAIN_ROLLOUT_MIN_REAL_DEMANDS,
      humanValueConfirmed: false,
    });
    expect(result.status).toBe('pending_human_value_review');
  });

  it('só libera com amostra e confirmação humana', () => {
    expect(
      evaluateDomainRolloutGate({
        domain: 'legaltech_lgpd',
        observedRealDemands: 5,
        humanValueConfirmed: true,
      }).status,
    ).toBe('go');
  });
});
