import type { Demand } from '@shared/schema';
import { logger } from '../utils/logger';
import { demandRepository } from '../repositories/demand-repository';
import {
  AnyFramework,
  FrameworkExecutionResult,
  FrameworkType,
  FrameworkRecommendation,
  FrameworkMetrics,
} from './types';
import { FrameworkRegistry } from './framework-registry';
import { FrameworkManager as LegacyFrameworkManager } from './framework-manager';
import { JTBDFrameworkImpl } from './implementations/jtbd';
import { HEARTFrameworkImpl } from './implementations/heart';
import { SeverityPriorityFrameworkImpl } from './implementations/severity-priority';
import { DoubleDiamondFrameworkImpl } from './implementations/double-diamond';
import { CRISPDMFrameworkImpl } from './implementations/crisp-dm';

/** Erro de domínio estável para as rotas mapearem 404 (spec 013 US2-AS3). */
export class FrameworkDomainError extends Error {
  constructor(
    public readonly code: 'framework_not_found' | 'demand_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'FrameworkDomainError';
  }
}

/**
 * Framework Manager - Fachada que delega para o FrameworkRegistry.
 * Mantém retrocompatibilidade com os consumidores existentes.
 */
export class FrameworkManager {
  private registry: FrameworkRegistry;
  private executionHistory: Map<string, FrameworkExecutionResult[]>;
  // Delega métodos legados (recomendação/métricas) ainda não migrados para o registry.
  private legacy: LegacyFrameworkManager;
  // Spec 013 (H-01/FR-004): inits repetidas reutilizam a mesma promise —
  // sem duplicar registros quando startup e ai-squad chamam ambos.
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.registry = new FrameworkRegistry();
    this.executionHistory = new Map();
    this.legacy = new LegacyFrameworkManager();
  }

  /**
   * Recomenda o framework adequado para a demanda (delega ao manager legado).
   */
  async recommendFramework(demand: Demand): Promise<FrameworkRecommendation> {
    return this.legacy.recommendFramework(demand);
  }

  /**
   * Retorna o resumo de métricas por framework (delega ao manager legado).
   */
  getFrameworkMetricsSummary(): Record<FrameworkType, FrameworkMetrics> {
    return this.legacy.getFrameworkMetricsSummary();
  }

  /**
   * Initialize the framework manager with default frameworks.
   * Idempotente: chamadas concorrentes/repetidas aguardam a mesma init.
   */
  initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInitialize().catch((error) => {
        // Falha de init não pode ficar memoizada como sucesso.
        this.initPromise = null;
        throw error;
      });
    }
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    logger.info('🔧 Initializing Framework Manager...');

    // Load any existing frameworks from storage
    await this.loadFrameworksFromStorage();

    // Create default framework templates
    await this.createDefaultFrameworks();

    // O delegado legado alimenta recomendação/métricas — inicializa junto
    // para que getFrameworkMetricsSummary reflita o mesmo estado da lista.
    await this.legacy.initialize();

    logger.info(`✅ Framework Manager initialized with ${this.registry.size()} frameworks`);
  }

  /**
   * Load frameworks from storage
   */
  private async loadFrameworksFromStorage(): Promise<void> {
    try {
      logger.info('📂 Loading frameworks from storage...');
    } catch (error) {
      logger.error('Error loading frameworks from storage:', error);
    }
  }

  /**
   * Create default framework templates
   */
  private async createDefaultFrameworks(): Promise<void> {
    // Register all frameworks using their default templates
    this.registry.register(new JTBDFrameworkImpl());
    this.registry.register(new HEARTFrameworkImpl());
    this.registry.register(new SeverityPriorityFrameworkImpl());
    this.registry.register(new DoubleDiamondFrameworkImpl());
    this.registry.register(new CRISPDMFrameworkImpl());
  }

  /**
   * Get framework by ID
   */
  getFrameworkById(id: string): AnyFramework | undefined {
    const impl = this.registry.get(id);
    if (impl) {
      return (impl as any).getData();
    }
    return undefined;
  }

  /**
   * Get frameworks by type
   */
  getFrameworksByType(type: FrameworkType): AnyFramework[] {
    const impls = this.registry.getByType(type);
    return impls.map((impl) => (impl as any).getData());
  }

  /**
   * Get all frameworks
   */
  getAllFrameworks(): AnyFramework[] {
    const impls = this.registry.getAll();
    return impls.map((impl) => (impl as any).getData());
  }

  /**
   * Execute framework for a demand
   */
  async executeFramework(
    demandId: number,
    frameworkId: string,
    onProgress?: (progress: number, message: string) => void,
  ): Promise<FrameworkExecutionResult> {
    const demand = await demandRepository.findByIdOrNull(demandId);
    if (!demand) {
      throw new FrameworkDomainError('demand_not_found', `Demand ${demandId} not found`);
    }

    const impl = this.registry.get(frameworkId);
    if (!impl) {
      throw new FrameworkDomainError('framework_not_found', `Framework ${frameworkId} not found`);
    }

    const executionResult: FrameworkExecutionResult = {
      frameworkId,
      frameworkName: impl.name,
      demandId,
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

    await demandRepository.update(demandId, {
      frameworkExecution: executionResult,
    });

    try {
      const result = await impl.execute(demand, onProgress);
      await demandRepository.update(demandId, {
        frameworkExecution: result,
      });
      this.appendToHistory(demandId, result);
      return result;
    } catch (error) {
      logger.error(`Error executing framework ${frameworkId} for demand ${demandId}:`, error);

      executionResult.status = 'failed';
      executionResult.progress = 0;
      if (error instanceof Error) {
        executionResult.outputs = { error: error.message };
      }

      await demandRepository.update(demandId, {
        frameworkExecution: executionResult,
        status: 'error',
      });
      this.appendToHistory(demandId, executionResult);

      throw error;
    }
  }

  private appendToHistory(demandId: number, result: FrameworkExecutionResult): void {
    const key = String(demandId);
    const history = this.executionHistory.get(key) ?? [];
    history.push(result);
    this.executionHistory.set(key, history);
  }

  /**
   * Get execution history
   */
  getExecutionHistory(demandId: string): FrameworkExecutionResult[] {
    return this.executionHistory.get(demandId) || [];
  }

  /**
   * Histórico com fallback ao snapshot persistido na demanda — a última
   * execução sobrevive a restart do processo (spec 013 FR-006).
   */
  async getExecutionHistoryAsync(demandId: string): Promise<FrameworkExecutionResult[]> {
    const inMemory = this.getExecutionHistory(demandId);
    if (inMemory.length > 0) return inMemory;

    const numericId = Number(demandId);
    if (!Number.isInteger(numericId) || numericId <= 0) return [];
    const demand = await demandRepository.findByIdOrNull(numericId);
    const persisted = demand?.frameworkExecution;
    return persisted ? [persisted] : [];
  }

  /**
   * Clear execution history
   */
  clearExecutionHistory(demandId: string): void {
    this.executionHistory.delete(demandId);
  }
}

// Singleton instance for retrocompatibility
export const frameworkManager = new FrameworkManager();
