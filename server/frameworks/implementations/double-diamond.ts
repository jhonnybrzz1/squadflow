import { Demand } from '@shared/schema';
import { IFramework } from '../framework-interface';
import { DoubleDiamondFramework, FrameworkExecutionResult, FrameworkMetrics } from '../types';

/**
 * Implementação do Framework Double Diamond.
 * Implementa a interface IFramework para permitir execução isolada.
 */
export class DoubleDiamondFrameworkImpl implements IFramework {
  private framework: DoubleDiamondFramework;

  constructor(framework?: DoubleDiamondFramework) {
    this.framework = framework || DoubleDiamondFrameworkImpl.getDefaultTemplate();
  }

  /**
   * Retorna o template padrão do framework
   */
  static getDefaultTemplate(): DoubleDiamondFramework {
    return {
      id: 'double-diamond-default',
      name: 'Double Diamond Framework',
      description: 'Design thinking framework for discovery and delivery',
      type: 'double-diamond',
      version: '1.0',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      discoverPhase: {
        researchMethods: [],
        insights: [],
        userNeeds: [],
        painPoints: [],
      },
      definePhase: {
        problemStatements: [],
        userJourneys: [],
        personas: [],
      },
      developPhase: {
        ideationMethods: [],
        prototypes: [],
        iterations: [],
      },
      deliverPhase: {
        testingMethods: [],
        launchPlan: '',
        feedbackCollection: [],
      },
      integration: {
        aiEnabled: true,
        externalTools: ['Figma', 'Miro'],
        apiEndpoints: [],
        dataSources: [],
        designTools: ['Figma', 'Sketch', 'Adobe XD'],
        collaborationTools: ['Miro', 'Mural', 'Figma'],
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
   * Executa o framework Double Diamond para uma demanda específica
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
      { name: 'Discover: Research', duration: 20 },
      { name: 'Discover: Insights', duration: 15 },
      { name: 'Define: Problem statement', duration: 20 },
      { name: 'Define: User journey', duration: 15 },
      { name: 'Develop: Ideation', duration: 25 },
      { name: 'Develop: Prototyping', duration: 20 },
      { name: 'Deliver: Testing', duration: 15 },
      { name: 'Deliver: Implementation', duration: 20 },
    ];

    let totalProgress = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      totalProgress += step.duration;
      const progress = Math.round(
        (totalProgress / steps.reduce((sum, s) => sum + s.duration, 0)) * 100,
      );

      if (onProgress) {
        onProgress(progress, `Double Diamond: ${step.name}`);
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
      stakeholderSatisfaction: 85,
      costEfficiency: 75,
      qualityScore: 90,
    };

    if (onProgress) {
      onProgress(100, 'Double Diamond Framework execution completed successfully');
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
      !!this.framework.discoverPhase &&
      !!this.framework.definePhase
    );
  }

  /**
   * Retorna as métricas do framework
   */
  getMetrics(): FrameworkMetrics {
    return {
      successRate: 85,
      completionTime: 0,
      stakeholderSatisfaction: 85,
      costEfficiency: 75,
      qualityScore: 90,
    };
  }

  /**
   * Atualiza os dados do framework
   */
  update(updates: Partial<DoubleDiamondFramework>): void {
    this.framework = {
      ...this.framework,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Retorna os dados brutos do framework
   */
  getData(): DoubleDiamondFramework {
    return { ...this.framework };
  }
}
