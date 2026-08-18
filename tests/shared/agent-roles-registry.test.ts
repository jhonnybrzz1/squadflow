import { describe, it, expect } from 'vitest';
import { AgentRole, ALL_AGENT_ROLES, isValidRole } from '../../shared/agent-roles';

describe('AgentRole registry utilities', () => {
  it('isValidRole returns true for registered roles', () => {
    for (const role of ALL_AGENT_ROLES) {
      expect(isValidRole(role)).toBe(true);
    }
  });

  it('isValidRole rejects invalid aliases like mimo 2.5/deepseek flash', () => {
    expect(isValidRole('mimo 2.5/deepseek flash')).toBe(false);
    expect(isValidRole('pm_ia')).toBe(false); // legacy, not canonical
    expect(isValidRole('pm_puro')).toBe(false); // legacy, not canonical
    expect(isValidRole('unknown')).toBe(false);
  });

  it('AgentRole enum values match their keys', () => {
    for (const [key, value] of Object.entries(AgentRole).filter(([, v]) => typeof v === 'string')) {
      expect(value).toBe(key);
    }
  });
});
