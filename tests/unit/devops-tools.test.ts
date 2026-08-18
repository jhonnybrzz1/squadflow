/**
 * Unit tests for server/services/devops-tools.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

async function importFresh() {
  const registry = await import('../../server/services/agent-tools-registry');
  const { registerDevOpsTools } = await import('../../server/services/devops-tools');
  return { registry, registerDevOpsTools };
}

describe('devops-tools', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('registers 4 DevOps tools', async () => {
    const { registry, registerDevOpsTools } = await importFresh();
    registerDevOpsTools();

    const devopsTools = registry.getToolsForAgent('devops');
    expect(devopsTools.map((t) => t.name).sort()).toEqual([
      'check_exposed_secrets',
      'check_outdated_dependencies',
      'check_security_headers',
      'validate_deploy_config',
    ]);
  });

  it('allows security_specialist and tech_lead to access some DevOps tools', async () => {
    const { registry, registerDevOpsTools } = await importFresh();
    registerDevOpsTools();

    const securityTools = registry.getToolsForAgent('security_specialist');
    const securityNames = securityTools.map((t) => t.name);
    expect(securityNames).toContain('check_security_headers');
    expect(securityNames).toContain('check_exposed_secrets');

    const techLeadTools = registry.getToolsForAgent('tech_lead');
    const techLeadNames = techLeadTools.map((t) => t.name);
    expect(techLeadNames).toContain('validate_deploy_config');
    expect(techLeadNames).toContain('check_outdated_dependencies');
  });
});
