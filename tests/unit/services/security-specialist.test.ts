import { describe, expect, it } from 'vitest';
import { AgentFactory } from '../../../server/services/ai-squad/AgentFactory';
import { DEMAND_TYPES } from '../../../shared/demand-types';

describe('Security Specialist', () => {
  it('é carregado pelo factory e exige a seção regulatória no prompt', () => {
    const loaded = new AgentFactory().loadConfigurations();
    expect(loaded.agents.map((agent) => agent.name)).toContain('security_specialist');
    expect(loaded.agentConfigs.security_specialist.system_prompt).toContain(
      'Segurança, Compliance e Riscos de Dados',
    );
    expect(DEMAND_TYPES.security.typeRequirements).toContain(
      'Seção Segurança, Compliance e Riscos de Dados',
    );
  });
});

describe('Architect', () => {
  it('é carregado pelo factory', () => {
    const loaded = new AgentFactory().loadConfigurations();
    expect(loaded.agents.map((agent) => agent.name)).toContain('architect');
    expect(loaded.agentConfigs.architect.system_prompt).toContain('Migração e rollback');
  });

  it('carrega o Financial Analyst com regra de citação de fonte', () => {
    const loaded = new AgentFactory().loadConfigurations();
    expect(loaded.agents.map((agent) => agent.name)).toContain('financial_analyst');
    expect(loaded.agentConfigs.financial_analyst.system_prompt).toContain(
      'Cite a fonte de cada afirmação financeira',
    );
  });
});
