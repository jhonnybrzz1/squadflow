import { describe, expect, it } from 'vitest';
import {
  calculateRoundtableMaxTurns,
  calculateRoundtableMaxTokensPerTurn,
  calculateRoundtableTokenBudget,
  selectParallelFirstCycleAgents,
  shouldRunParallelFirstCycle,
} from '../../server/services/ai-squad/roundtable-latency-policy';

describe('roundtable latency policy', () => {
  it('gives level 1 one contribution per agent', () => {
    expect(calculateRoundtableMaxTurns(5, 2, 1)).toBe(5);
  });

  it('gives level 2 one and a half contributions per agent', () => {
    expect(calculateRoundtableMaxTurns(5, 2, 2)).toBe(8);
  });

  it('preserves at least two rounds and six turns for level 3', () => {
    expect(calculateRoundtableMaxTurns(5, 1, 3)).toBe(10);
    expect(calculateRoundtableMaxTurns(2, 1, 3)).toBe(6);
  });

  it('uses progressively larger token budgets by refinement level', () => {
    expect(calculateRoundtableTokenBudget(5, 1)).toBe(4500);
    expect(calculateRoundtableTokenBudget(5, 2)).toBe(6000);
    expect(calculateRoundtableTokenBudget(5, 3)).toBe(7500);
  });

  it('aligns the per-turn cap with the global budget', () => {
    expect(calculateRoundtableMaxTokensPerTurn(1)).toBe(900);
    expect(calculateRoundtableMaxTokensPerTurn(2)).toBe(1200);
    expect(calculateRoundtableMaxTokensPerTurn(3)).toBe(1500);
  });

  it('parallelizes only the first cycle after the PO in levels 1 and 2', () => {
    expect(
      shouldRunParallelFirstCycle({
        enabled: true,
        initialized: false,
        turnCount: 1,
        refinementLevel: 2,
      }),
    ).toBe(true);
    expect(
      shouldRunParallelFirstCycle({
        enabled: true,
        initialized: false,
        turnCount: 1,
        refinementLevel: 3,
      }),
    ).toBe(false);
    expect(
      shouldRunParallelFirstCycle({
        enabled: true,
        initialized: true,
        turnCount: 1,
        refinementLevel: 1,
      }),
    ).toBe(false);
  });

  it('preserves deterministic order and excludes the opening PO', () => {
    expect(
      selectParallelFirstCycleAgents(['product_owner', 'tech_lead', 'qa', 'ux_designer'], 4),
    ).toEqual(['tech_lead', 'qa', 'ux_designer']);
  });
});
