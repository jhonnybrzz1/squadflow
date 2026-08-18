import { describe, expect, it } from 'vitest';
import {
  shouldUseLlmModerator,
  shouldUseRedTeam,
} from '../../server/services/ai-squad/roundtable-policy';

describe('roundtable cost policy', () => {
  it('uses deterministic moderation for refinement levels 1 and 2 in hybrid mode', () => {
    expect(shouldUseLlmModerator('hybrid', 1)).toBe(false);
    expect(shouldUseLlmModerator('hybrid', 2)).toBe(false);
    expect(shouldUseLlmModerator('hybrid', 3)).toBe(true);
  });

  it('honors explicit moderator modes', () => {
    expect(shouldUseLlmModerator('llm', 1)).toBe(true);
    expect(shouldUseLlmModerator('round-robin', 3)).toBe(false);
  });

  it('runs red-team only for level 3 when enabled', () => {
    expect(shouldUseRedTeam(true, 1)).toBe(false);
    expect(shouldUseRedTeam(true, 2)).toBe(false);
    expect(shouldUseRedTeam(true, 3)).toBe(true);
    expect(shouldUseRedTeam(false, 3)).toBe(false);
  });
});
