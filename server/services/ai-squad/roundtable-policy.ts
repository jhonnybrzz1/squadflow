export type RoundtableModeratorMode = 'llm' | 'round-robin' | 'hybrid';
export type RefinementLevel = 1 | 2 | 3;

export function shouldUseLlmModerator(
  mode: RoundtableModeratorMode,
  refinementLevel: RefinementLevel,
): boolean {
  if (mode === 'llm') return true;
  if (mode === 'round-robin') return false;
  return refinementLevel === 3;
}

export function shouldUseRedTeam(enabled: boolean, refinementLevel: RefinementLevel): boolean {
  return enabled && refinementLevel === 3;
}
