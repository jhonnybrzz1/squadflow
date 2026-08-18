import { describe, it, expect, vi } from 'vitest';
import { AISquadService } from '../../server/services/ai-squad';
import { featureFlags } from '../../server/services/feature-flags';

describe('RC #10234: Response Contract pilot expansion', () => {
  it('product_owner and ux are enabled when pilot list contains them', () => {
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
      agentResponseSchemaPilot: true,
      agentResponseSchemaPilotAgents: ['scrum_master', 'product_owner', 'ux'],
    });

    const svc = new AISquadService();
    expect(svc.isResponseContractEnabledForAgent('product_owner')).toBe(true);
    expect(svc.isResponseContractEnabledForAgent('ux')).toBe(true);
    expect(svc.isResponseContractEnabledForAgent('tech_lead')).toBe(false);
  });

  it('config/feature-flags.json includes product_owner and ux', () => {
    const config = require('../../config/feature-flags.json');
    expect(config.agentResponseSchemaPilot).toBe(true);
    expect(config.agentResponseSchemaPilotAgents).toContain('product_owner');
    expect(config.agentResponseSchemaPilotAgents).toContain('ux');
  });
});
