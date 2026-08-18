import { describe, it, expect } from 'vitest';
import { DoubleDiamondFrameworkImpl } from '../server/frameworks/implementations/double-diamond';
import { Demand } from '@shared/schema';

describe('DoubleDiamondFrameworkImpl', () => {
  it('creates framework with default template', () => {
    const framework = new DoubleDiamondFrameworkImpl();
    expect(framework.id).toBe('double-diamond-default');
    expect(framework.name).toBe('Double Diamond Framework');
    expect(framework.type).toBe('double-diamond');
  });

  it('creates framework with custom data', () => {
    const customData = {
      id: 'double-diamond-custom',
      name: 'Custom Double Diamond',
    };
    const framework = new DoubleDiamondFrameworkImpl(customData as any);
    expect(framework.id).toBe('double-diamond-custom');
    expect(framework.name).toBe('Custom Double Diamond');
  });

  it('validates framework correctly', () => {
    const framework = new DoubleDiamondFrameworkImpl();
    // Default template has discoverPhase and definePhase, so validation returns true
    expect(framework.validate()).toBe(true);
  });

  it('returns metrics', () => {
    const framework = new DoubleDiamondFrameworkImpl();
    const metrics = framework.getMetrics();
    expect(metrics).toHaveProperty('successRate');
    expect(metrics).toHaveProperty('completionTime');
    expect(metrics).toHaveProperty('stakeholderSatisfaction');
  });

  it('executes framework', async () => {
    const framework = new DoubleDiamondFrameworkImpl();
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
