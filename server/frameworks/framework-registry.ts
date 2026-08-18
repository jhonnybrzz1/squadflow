import { IFramework } from './framework-interface';
import { logger } from '../utils/logger';

/**
 * Registry central para gerenciar instâncias de frameworks.
 * Implementa o padrão Registry para permitir adicionar/remover frameworks dinamicamente.
 */
export class FrameworkRegistry {
  private frameworks: Map<string, IFramework>;

  constructor() {
    this.frameworks = new Map();
  }

  /**
   * Registra um framework no registry
   *
   * @param framework - A instância do framework a ser registrada
   */
  register(framework: IFramework): void {
    if (this.frameworks.has(framework.id)) {
      logger.warn(`Framework ${framework.id} already registered, overwriting`);
    }
    this.frameworks.set(framework.id, framework);
    logger.info(`Framework ${framework.id} (${framework.name}) registered`);
  }

  /**
   * Remove um framework do registry
   *
   * @param id - ID do framework a ser removido
   * @returns true se removido, false se não encontrado
   */
  unregister(id: string): boolean {
    const result = this.frameworks.delete(id);
    if (result) {
      logger.info(`Framework ${id} unregistered`);
    }
    return result;
  }

  /**
   * Obtém um framework por ID
   *
   * @param id - ID do framework
   * @returns A instância do framework ou undefined se não encontrado
   */
  get(id: string): IFramework | undefined {
    return this.frameworks.get(id);
  }

  /**
   * Obtém todos os frameworks registrados
   *
   * @returns Array com todos os frameworks
   */
  getAll(): IFramework[] {
    return Array.from(this.frameworks.values());
  }

  /**
   * Obtém frameworks por tipo
   *
   * @param type - Tipo do framework
   * @returns Array com frameworks do tipo especificado
   */
  getByType(type: string): IFramework[] {
    return Array.from(this.frameworks.values()).filter((f) => f.type === type);
  }

  /**
   * Verifica se um framework está registrado
   *
   * @param id - ID do framework
   * @returns true se registrado, false caso contrário
   */
  has(id: string): boolean {
    return this.frameworks.has(id);
  }

  /**
   * Retorna o número de frameworks registrados
   *
   * @returns Número de frameworks
   */
  size(): number {
    return this.frameworks.size;
  }

  /**
   * Limpa todos os frameworks do registry
   */
  clear(): void {
    this.frameworks.clear();
    logger.info('Framework registry cleared');
  }
}
