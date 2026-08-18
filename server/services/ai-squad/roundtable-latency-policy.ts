import type { RefinementLevel } from './roundtable-policy';

export function calculateRoundtableMaxTurns(
  agentCount: number,
  requestedRounds: number,
  refinementLevel: RefinementLevel,
): number {
  const agents = Math.max(1, agentCount);
  if (refinementLevel === 1) return agents;
  if (refinementLevel === 2) return Math.ceil(agents * 1.5);
  return Math.max(6, agents * Math.max(2, requestedRounds));
}

export function calculateRoundtableTokenBudget(
  maxTurns: number,
  refinementLevel: RefinementLevel,
): number {
  return maxTurns * calculateRoundtableMaxTokensPerTurn(refinementLevel);
}

export function calculateRoundtableMaxTokensPerTurn(refinementLevel: RefinementLevel): number {
  if (refinementLevel === 1) return 900;
  if (refinementLevel === 2) return 1200;
  return 1500;
}

export function shouldRunParallelFirstCycle(params: {
  enabled: boolean;
  initialized: boolean;
  turnCount: number;
  refinementLevel: RefinementLevel;
}): boolean {
  return (
    params.enabled && !params.initialized && params.turnCount === 1 && params.refinementLevel <= 2
  );
}

export function selectParallelFirstCycleAgents(agentIds: string[], maxTurns: number): string[] {
  return agentIds.slice(1, Math.min(agentIds.length, maxTurns));
}
