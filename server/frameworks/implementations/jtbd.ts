import { Demand } from '@shared/schema';
import { IFramework } from '../framework-interface';
import { JTBDFramework, FrameworkExecutionResult, FrameworkMetrics } from '../types';

/**
 * Implementação do Framework Jobs-to-be-Done (JTBD).
 * Implementa a interface IFramework para permitir execução isolada.
 */
export class JTBDFrameworkImpl implements IFramework {
  private framework: JTBDFramework;

  constructor(framework?: JTBDFramework) {
    this.framework = framework || JTBDFrameworkImpl.getDefaultTemplate();
  }

  /**
   * Retorna o template padrão do framework
   */
  static getDefaultTemplate(): JTBDFramework {
    return {
      id: 'jtbd-default',
      name: 'Jobs-to-be-Done Framework',
      description: 'Framework for understanding customer jobs and desired outcomes',
      type: 'jtbd',
      version: '1.0',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      jobStatement: '',
      jobSteps: [],
      desiredOutcomes: [],
      constraints: [],
      successMetrics: {
        jobCompletionRate: 0,
        customerSatisfaction: 0,
        timeToComplete: 0,
      },
      integration: {
        aiEnabled: true,
        externalTools: ['SurveyMonkey', 'Typeform'],
        apiEndpoints: [],
        dataSources: [],
        customerInterviews: true,
        surveyTools: ['SurveyMonkey', 'Typeform', 'Google Forms'],
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
   * Executa o framework JTBD para uma demanda específica
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
      { name: 'Analyzing job statement', duration: 15 },
      { name: 'Identifying job steps', duration: 20 },
      { name: 'Defining desired outcomes', duration: 25 },
      { name: 'Analyzing constraints', duration: 20 },
      { name: 'Designing solution', duration: 30 },
      { name: 'Validating with customers', duration: 25 },
      { name: 'Finalizing implementation', duration: 15 },
    ];

    let totalProgress = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      totalProgress += step.duration;
      const progress = Math.round(
        (totalProgress / steps.reduce((sum, s) => sum + s.duration, 0)) * 100,
      );

      if (onProgress) {
        onProgress(progress, `JTBD: ${step.name}`);
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
      successRate: 85,
      completionTime: executionResult.timeline.duration,
      stakeholderSatisfaction: 80,
      costEfficiency: 75,
      qualityScore: 85,
    };

    if (onProgress) {
      onProgress(100, 'JTBD Framework execution completed successfully');
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
      !!this.framework.jobStatement
    );
  }

  /**
   * Retorna as métricas do framework
   */
  getMetrics(): FrameworkMetrics {
    return {
      successRate: this.framework.successMetrics.jobCompletionRate,
      completionTime: this.framework.successMetrics.timeToComplete,
      stakeholderSatisfaction: this.framework.successMetrics.customerSatisfaction,
      costEfficiency: 75,
      qualityScore: 85,
    };
  }

  /**
   * Atualiza os dados do framework
   */
  update(updates: Partial<JTBDFramework>): void {
    this.framework = {
      ...this.framework,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Retorna os dados brutos do framework
   */
  getData(): JTBDFramework {
    return { ...this.framework };
  }
}
