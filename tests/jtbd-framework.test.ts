import { describe, it, expect } from 'vitest';
import { JTBDFrameworkImpl } from '../server/frameworks/implementations/jtbd';
import { Demand } from '@shared/schema';

describe('JTBDFrameworkImpl', () => {
  it('creates framework with default template', () => {
    const framework = new JTBDFrameworkImpl();
    expect(framework.id).toBe('jtbd-default');
    expect(framework.name).toBe('Jobs-to-be-Done Framework');
    expect(framework.type).toBe('jtbd');
  });

  it('creates framework with custom data', () => {
    const customData = {
      id: 'jtbd-custom',
      name: 'Custom JTBD',
      jobStatement: 'Test job',
    };
    const framework = new JTBDFrameworkImpl(customData as any);
    expect(framework.id).toBe('jtbd-custom');
    expect(framework.name).toBe('Custom JTBD');
  });

  it('validates framework correctly', () => {
    const framework = new JTBDFrameworkImpl();
    // Default template has empty jobStatement, so validation returns false
    expect(framework.validate()).toBe(false);
  });

  it('returns metrics', () => {
    const framework = new JTBDFrameworkImpl();
    const metrics = framework.getMetrics();
    expect(metrics).toHaveProperty('successRate');
    expect(metrics).toHaveProperty('completionTime');
    expect(metrics).toHaveProperty('stakeholderSatisfaction');
  });

  it('executes framework', async () => {
    const framework = new JTBDFrameworkImpl();
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
