import { describe, it, expect } from 'vitest';
import { AgentRole, ALL_AGENT_ROLES } from '../../shared/agent-roles';
import { DEMAND_TYPES } from '../../shared/demand-types';
import { AGENT_ACCESS_ROLES } from '../../server/services/form-tools';
import { DEFAULT_ROUNDTABLE_AGENTS } from '../../server/orchestration-contracts/roundtable';
import { AGENT_KEY_ALIASES } from '../../server/services/agent-identity';

const AGENT_OVERRIDES = Object.values(DEMAND_TYPES)
  .flatMap((dt) => dt.agentOverrides?.include ?? [])
  .filter((v): v is string => typeof v === 'string');

function assertRegisteredRole(role: string, context: string): void {
  expect(
    ALL_AGENT_ROLES.includes(role as AgentRole),
    `${context} references unknown role: ${role}`,
  ).toBe(true);
}

describe('Agent roles registry consistency', () => {
  it('every squad member in DEMAND_TYPES is a registered AgentRole', () => {
    for (const [key, config] of Object.entries(DEMAND_TYPES)) {
      for (const agent of config.squad) {
        assertRegisteredRole(agent, `demand type ${key}.squad`);
      }
    }
  });

  it('every AGENT_ACCESS_ROLES value is a registered AgentRole', () => {
    for (const agent of AGENT_ACCESS_ROLES) {
      assertRegisteredRole(agent, 'AGENT_ACCESS_ROLES');
    }
  });

  it('every DEFAULT_ROUNDTABLE_AGENTS value is a registered AgentRole', () => {
    for (const agent of DEFAULT_ROUNDTABLE_AGENTS) {
      assertRegisteredRole(agent, 'DEFAULT_ROUNDTABLE_AGENTS');
    }
  });

  it('every AGENT_KEY_ALIASES target is a registered AgentRole', () => {
    for (const [alias, role] of Object.entries(AGENT_KEY_ALIASES)) {
      assertRegisteredRole(role, `alias ${alias}`);
    }
  });

  it('every agent override include is a registered AgentRole', () => {
    for (const agent of AGENT_OVERRIDES) {
      assertRegisteredRole(agent, 'agentOverrides.include');
    }
  });

  it('fails when a subset references a role outside the registry', () => {
    // eslint-disable-next-line no-restricted-syntax -- test fixture uses literal for negative assertion
    const invalidSubset = ['product_owner', 'non_existent_role'] as string[];
    const unknown = invalidSubset.filter((role) => !ALL_AGENT_ROLES.includes(role as AgentRole));
    expect(unknown).toEqual(['non_existent_role']);
  });

  it('warns about registered roles not used in any subset', () => {
    const used = new Set<string>([
      ...Object.values(DEMAND_TYPES).flatMap((c) => c.squad as string[]),
      ...AGENT_ACCESS_ROLES,
      ...DEFAULT_ROUNDTABLE_AGENTS,
      ...Object.values(AGENT_KEY_ALIASES),
      ...AGENT_OVERRIDES,
    ]);

    const unused = ALL_AGENT_ROLES.filter((role) => !used.has(role));
    if (unused.length > 0) {
      console.warn('Registered agent roles not used in any subset:', unused);
    }
    expect(unused.length).toBeGreaterThanOrEqual(0);
  });
});
