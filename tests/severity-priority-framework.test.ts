import { describe, it, expect } from 'vitest';
import { SeverityPriorityFrameworkImpl } from '../server/frameworks/implementations/severity-priority';
import { Demand } from '@shared/schema';

describe('SeverityPriorityFrameworkImpl', () => {
  it('creates framework with default template', () => {
    const framework = new SeverityPriorityFrameworkImpl();
    expect(framework.id).toBe('severity-priority-default');
    expect(framework.name).toBe('Severity x Priority Matrix');
    expect(framework.type).toBe('severity-priority');
  });

  it('creates framework with custom data', () => {
    const customData = {
      id: 'severity-custom',
      name: 'Custom Severity-Priority',
    };
    const framework = new SeverityPriorityFrameworkImpl(customData as any);
    expect(framework.id).toBe('severity-custom');
    expect(framework.name).toBe('Custom Severity-Priority');
  });

  it('validates framework correctly', () => {
    const framework = new SeverityPriorityFrameworkImpl();
    // Default template has severityLevels, so validation returns true
    expect(framework.validate()).toBe(true);
  });

  it('returns metrics', () => {
    const framework = new SeverityPriorityFrameworkImpl();
    const metrics = framework.getMetrics();
    expect(metrics).toHaveProperty('successRate');
    expect(metrics).toHaveProperty('completionTime');
    expect(metrics).toHaveProperty('stakeholderSatisfaction');
  });

  it('executes framework', async () => {
    const framework = new SeverityPriorityFrameworkImpl();
    const demand: Partial<Demand> = {
      id: 'test-demand',
      type: 'bug',
      priority: 'critica',
      status: 'draft',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await framework.execute(demand as Demand);
    expect(result.status).toBe('completed');
    expect(result.progress).toBe(100);
  });
});
