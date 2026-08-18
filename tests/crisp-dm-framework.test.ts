import { describe, it, expect } from 'vitest';
import { CRISPDMFrameworkImpl } from '../server/frameworks/implementations/crisp-dm';
import { Demand } from '@shared/schema';

describe('CRISPDMFrameworkImpl', () => {
  it('creates framework with default template', () => {
    const framework = new CRISPDMFrameworkImpl();
    expect(framework.id).toBe('crisp-dm-default');
    expect(framework.name).toBe('CRISP-DM Framework');
    expect(framework.type).toBe('crisp-dm');
  });

  it('creates framework with custom data', () => {
    const customData = {
      id: 'crisp-dm-custom',
      name: 'Custom CRISP-DM',
    };
    const framework = new CRISPDMFrameworkImpl(customData as any);
    expect(framework.id).toBe('crisp-dm-custom');
    expect(framework.name).toBe('Custom CRISP-DM');
  });

  it('validates framework correctly', () => {
    const framework = new CRISPDMFrameworkImpl();
    // Default template has businessUnderstanding and dataUnderstanding, so validation returns true
    expect(framework.validate()).toBe(true);
  });

  it('returns metrics', () => {
    const framework = new CRISPDMFrameworkImpl();
    const metrics = framework.getMetrics();
    expect(metrics).toHaveProperty('successRate');
    expect(metrics).toHaveProperty('completionTime');
    expect(metrics).toHaveProperty('stakeholderSatisfaction');
  });

  it('executes framework', async () => {
    const framework = new CRISPDMFrameworkImpl();
    const demand: Partial<Demand> = {
      id: 'test-demand',
      type: 'feature',
      priority: 'alta',
      status: 'draft',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await framework.execute(demand as Demand);
    expect(result.status).toBe('completed');
    expect(result.progress).toBe(100);
  });
});
