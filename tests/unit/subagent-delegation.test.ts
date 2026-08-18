/**
 * Demanda 10100 — Subagent delegation: gate de profundidade, semaphore e custo.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  requestDelegation,
  releaseSubagent,
  resetSubagentStateForTests,
} from '../../server/services/subagent-delegation';
import { featureFlags } from '../../server/services/feature-flags';

vi.mock('../../server/services/openrouter-pricing', () => ({
  getCachedPricing: vi.fn().mockResolvedValue({
    inputUsdPer1M: 1,
    outputUsdPer1M: 2,
  }),
}));

describe('Subagent Delegation', () => {
  beforeEach(() => {
    resetSubagentStateForTests();
    featureFlags.setOverride('enableSubagentDelegation', true);
    featureFlags.setOverride('maxConcurrentSubagents', 3);
    featureFlags.setOverride('maxDelegationCostPerTask', 2.0);
  });

  it('rejeita delegação quando feature flag está desligada', async () => {
    featureFlags.setOverride('enableSubagentDelegation', false);
    const result = await requestDelegation({
      coordinatorId: 'c1',
      subagentName: 'tech_lead',
      model: 'm',
      estimatedInputTokens: 100,
      estimatedOutputTokens: 100,
      isSubagent: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('DEPTH_LIMIT');
  });

  it('rejeita subagente tentando delegar (depth > 1)', async () => {
    const result = await requestDelegation({
      coordinatorId: 'c1',
      subagentName: 'tech_lead',
      model: 'm',
      estimatedInputTokens: 100,
      estimatedOutputTokens: 100,
      isSubagent: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('DEPTH_LIMIT');
    expect(result.error?.maxDepth).toBe(1);
  });

  it('aprova até 3 delegações simultâneas e rejeita a 4ª', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await requestDelegation({
        coordinatorId: 'c1',
        subagentName: `sub${i}`,
        model: 'm',
        estimatedInputTokens: 100,
        estimatedOutputTokens: 100,
        isSubagent: false,
      });
      expect(r.ok).toBe(true);
    }

    const r4 = await requestDelegation({
      coordinatorId: 'c1',
      subagentName: 'sub4',
      model: 'm',
      estimatedInputTokens: 100,
      estimatedOutputTokens: 100,
      isSubagent: false,
    });
    expect(r4.ok).toBe(false);
    expect(r4.error?.code).toBe('DELEGATION_LIMIT');
    expect(r4.error?.maxConcurrent).toBe(3);
  });

  it('libera slot ao chamar releaseSubagent', async () => {
    const r1 = await requestDelegation({
      coordinatorId: 'c1',
      subagentName: 'sub1',
      model: 'm',
      estimatedInputTokens: 100,
      estimatedOutputTokens: 100,
      isSubagent: false,
    });
    expect(r1.ok).toBe(true);

    releaseSubagent('c1');

    const r2 = await requestDelegation({
      coordinatorId: 'c1',
      subagentName: 'sub2',
      model: 'm',
      estimatedInputTokens: 100,
      estimatedOutputTokens: 100,
      isSubagent: false,
    });
    expect(r2.ok).toBe(true);
  });

  it('rejeita quando custo acumulado ultrapassa limite', async () => {
    featureFlags.setOverride('maxDelegationCostPerTask', 0.0001);
    const result = await requestDelegation({
      coordinatorId: 'c1',
      subagentName: 'sub1',
      model: 'm',
      estimatedInputTokens: 1000,
      estimatedOutputTokens: 1000,
      isSubagent: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('DELEGATION_COST_LIMIT');
    expect(result.error?.maxCost).toBe(0.0001);
  });
});
