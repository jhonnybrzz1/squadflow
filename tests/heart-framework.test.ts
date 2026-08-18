import { describe, it, expect } from 'vitest';
import { HEARTFrameworkImpl } from '../server/frameworks/implementations/heart';
import { Demand } from '@shared/schema';

describe('HEARTFrameworkImpl', () => {
  it('creates framework with default template', () => {
    const framework = new HEARTFrameworkImpl();
    expect(framework.id).toBe('heart-default');
    expect(framework.name).toBe('HEART Framework');
    expect(framework.type).toBe('heart');
  });

  it('creates framework with custom data', () => {
    const customData = {
      id: 'heart-custom',
      name: 'Custom HEART',
    };
    const framework = new HEARTFrameworkImpl(customData as any);
    expect(framework.id).toBe('heart-custom');
    expect(framework.name).toBe('Custom HEART');
  });

  it('validates framework correctly', () => {
    const framework = new HEARTFrameworkImpl();
    // Default template has happiness.currentScore = 0, so validation returns true
    expect(framework.validate()).toBe(true);
  });

  it('returns metrics', () => {
    const framework = new HEARTFrameworkImpl();
    const metrics = framework.getMetrics();
    expect(metrics).toHaveProperty('successRate');
    expect(metrics).toHaveProperty('completionTime');
    expect(metrics).toHaveProperty('stakeholderSatisfaction');
  });

  it('executes framework', async () => {
    const framework = new HEARTFrameworkImpl();
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
