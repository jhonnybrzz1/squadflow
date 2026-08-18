import { describe, it, expect } from 'vitest';
import { getDemandTypeRoutingConfig, DEMAND_TYPES } from '../shared/demand-types';

describe('Demand Type Metadata Consistency', () => {
  Object.entries(DEMAND_TYPES).forEach(([type, config]) => {
    it(`should have all required fields for ${type}`, () => {
      expect(config).toHaveProperty('label');
      expect(config).toHaveProperty('shortLabel');
      expect(config).toHaveProperty('icon');
      expect(config).toHaveProperty('color');
      expect(config).toHaveProperty('prdTemplate');
      expect(config).toHaveProperty('refinementLevel');
      expect(config).toHaveProperty('intensity');
      expect(config).toHaveProperty('defaultTeam');
      expect(config).toHaveProperty('defaultResolutionMinutes');
      expect(config).toHaveProperty('complexityAdjustment');
      expect(config).toHaveProperty('baseSuccessRate');
      expect(config).toHaveProperty('canonicalDemandType');
      expect(config).toHaveProperty('outputType');
      expect(config).toHaveProperty('typeRequirements');
      expect(Array.isArray(config.typeRequirements)).toBe(true);
      expect(config).toHaveProperty('maxEffortDays');
      expect(config).toHaveProperty('minROI');
      expect(config).toHaveProperty('primaryFramework');
      expect(config).toHaveProperty('secondaryFrameworks');
      expect(Array.isArray(config.secondaryFrameworks)).toBe(true);
      expect(config).toHaveProperty('resolutionMultiplier');
      expect(config).toHaveProperty('classifierScoreAdjustments');
      expect(config).toHaveProperty('category');
      expect(config).toHaveProperty('squad');
      expect(config).toHaveProperty('constraints');
      expect(config).toHaveProperty('keywords');
      expect(config).toHaveProperty('regex');
      expect(config.squad.length).toBeGreaterThan(0);
      expect(config.keywords.length).toBeGreaterThan(0);
      expect(config.regex.length).toBeGreaterThan(0);
      expect(config.constraints).toMatchObject({
        maxTechnicalDepth: expect.any(String),
        maxScope: expect.any(String),
        requireAppSecReview: expect.any(Boolean),
        maxRounds: expect.any(Number),
        defaultRefinementLevel: expect.any(Number),
      });
    });
  });

  it('expõe routing config completo para os tipos P1 recentes', () => {
    expect(getDemandTypeRoutingConfig('security')).toMatchObject({
      category: 'legal',
      constraints: { requireAppSecReview: true },
      agentOverrides: { include: ['security_specialist'] },
    });
    expect(getDemandTypeRoutingConfig('refactoring').squad).toContain('architect');
    expect(getDemandTypeRoutingConfig('infraestrutura')).toMatchObject({
      category: 'technical',
      constraints: { requireAppSecReview: true },
    });
  });
});
