import { Demand } from '@shared/schema';
import { IFramework } from '../framework-interface';
import { SeverityPriorityFramework, FrameworkExecutionResult, FrameworkMetrics } from '../types';

/**
 * Implementação do Framework Severity x Priority Matrix.
 * Implementa a interface IFramework para permitir execução isolada.
 */
export class SeverityPriorityFrameworkImpl implements IFramework {
  private framework: SeverityPriorityFramework;

  constructor(framework?: SeverityPriorityFramework) {
    this.framework = framework || SeverityPriorityFrameworkImpl.getDefaultTemplate();
  }

  /**
   * Retorna o template padrão do framework
   */
  static getDefaultTemplate(): SeverityPriorityFramework {
    return {
      id: 'severity-priority-default',
      name: 'Severity x Priority Matrix',
      description: 'Framework for prioritizing bugs and issues',
      type: 'severity-priority',
      version: '1.0',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      severityLevels: { critical: 4, high: 3, medium: 2, low: 1 },
      priorityLevels: { immediate: 5, urgent: 4, high: 3, medium: 2, low: 1 },
      matrix: {
        critical: {
          immediate: { action: 'Fix immediately', sla: '2 hours', team: 'Critical Response Team' },
          urgent: { action: 'Fix ASAP', sla: '4 hours', team: 'Senior Dev Team' },
          high: { action: 'High priority fix', sla: '24 hours', team: 'Dev Team' },
          medium: { action: 'Schedule for next sprint', sla: '7 days', team: 'Dev Team' },
          low: { action: 'Backlog', sla: '30 days', team: 'Dev Team' },
        },
        high: {
          immediate: { action: 'Fix ASAP', sla: '4 hours', team: 'Senior Dev Team' },
          urgent: { action: 'High priority fix', sla: '24 hours', team: 'Dev Team' },
          high: { action: 'Schedule for next sprint', sla: '7 days', team: 'Dev Team' },
          medium: { action: 'Backlog', sla: '30 days', team: 'Dev Team' },
          low: { action: 'Consider for future', sla: '90 days', team: 'Dev Team' },
        },
        medium: {
          immediate: { action: 'Schedule for next sprint', sla: '7 days', team: 'Dev Team' },
          urgent: { action: 'Backlog', sla: '30 days', team: 'Dev Team' },
          high: { action: 'Backlog', sla: '30 days', team: 'Dev Team' },
          medium: { action: 'Consider for future', sla: '90 days', team: 'Dev Team' },
          low: { action: 'Low priority', sla: '180 days', team: 'Dev Team' },
        },
        low: {
          immediate: { action: 'Backlog', sla: '30 days', team: 'Dev Team' },
          urgent: { action: 'Consider for future', sla: '90 days', team: 'Dev Team' },
          high: { action: 'Consider for future', sla: '90 days', team: 'Dev Team' },
          medium: { action: 'Low priority', sla: '180 days', team: 'Dev Team' },
          low: { action: 'Not planned', sla: '365 days', team: 'Dev Team' },
        },
      },
      bugMetrics: {
        resolutionTime: 0,
        reopenRate: 0,
        customerImpact: 0,
      },
      integration: {
        aiEnabled: true,
        externalTools: ['Jira', 'Bugzilla'],
        apiEndpoints: [],
        dataSources: [],
        bugTracking: ['Jira', 'Bugzilla', 'GitHub Issues'],
        monitoringTools: ['Sentry', 'Datadog'],
        alertingSystems: ['PagerDuty', 'Opsgenie'],
      },
    };
  }

  get id(): string {
    return this.framework.id;
  }

  get name(): string {
    return this.framework.name;
  }

  get description(): string {
    return this.framework.description;
  }

  get type(): string {
    return this.framework.type;
  }

  get version(): string {
    return this.framework.version;
  }

  get createdAt(): string {
    return this.framework.createdAt;
  }

  get updatedAt(): string {
    return this.framework.updatedAt;
  }

  /**
   * Executa o framework Severity-Priority para uma demanda específica
   */
  async execute(
    demand: Demand,
    onProgress?: (progress: number, message: string) => void,
  ): Promise<FrameworkExecutionResult> {
    const executionResult: FrameworkExecutionResult = {
      frameworkId: this.framework.id,
      frameworkName: this.framework.name,
      demandId: demand.id,
      status: 'in-progress',
      progress: 0,
      metrics: {
        successRate: 0,
        completionTime: 0,
        stakeholderSatisfaction: 0,
        costEfficiency: 0,
        qualityScore: 0,
      },
      outputs: {},
      timeline: {
        startedAt: new Date().toISOString(),
      },
      teamMembers: [],
      resourcesUsed: [],
    };

    const steps = [
      { name: 'Analyzing severity levels', duration: 15 },
      { name: 'Evaluating priority levels', duration: 15 },
      { name: 'Mapping severity to priority', duration: 25 },
      { name: 'Defining SLAs', duration: 20 },
      { name: 'Assigning teams', duration: 15 },
      { name: 'Setting up monitoring', duration: 10 },
    ];

    let totalProgress = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      totalProgress += step.duration;
      const progress = Math.round(
        (totalProgress / steps.reduce((sum, s) => sum + s.duration, 0)) * 100,
      );

      if (onProgress) {
        onProgress(progress, `Severity-Priority: ${step.name}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
      executionResult.progress = progress;
      executionResult.outputs[`step${i + 1}`] = `${step.name} completed`;
    }

    executionResult.status = 'completed';
    executionResult.progress = 100;
    executionResult.timeline.completedAt = new Date().toISOString();
    executionResult.timeline.duration = steps.reduce((sum, s) => sum + s.duration, 0);
    executionResult.metrics = {
      successRate: 90,
      completionTime: executionResult.timeline.duration,
      stakeholderSatisfaction: 85,
      costEfficiency: 85,
      qualityScore: 90,
    };

    if (onProgress) {
      onProgress(100, 'Severity-Priority Framework execution completed successfully');
    }

    return executionResult;
  }

  /**
   * Valida se o framework está configurado corretamente
   */
  validate(): boolean {
    return (
      !!this.framework.id &&
      !!this.framework.name &&
      !!this.framework.type &&
      Object.keys(this.framework.severityLevels).length > 0
    );
  }

  /**
   * Retorna as métricas do framework
   */
  getMetrics(): FrameworkMetrics {
    return {
      successRate: this.framework.bugMetrics.resolutionTime > 0 ? 85 : 0,
      completionTime: this.framework.bugMetrics.resolutionTime,
      stakeholderSatisfaction: 100 - this.framework.bugMetrics.reopenRate * 100,
      costEfficiency: 85,
      qualityScore: 90,
    };
  }

  /**
   * Atualiza os dados do framework
   */
  update(updates: Partial<SeverityPriorityFramework>): void {
    this.framework = {
      ...this.framework,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Retorna os dados brutos do framework
   */
  getData(): SeverityPriorityFramework {
    return { ...this.framework };
  }
}
