import { Demand } from '@shared/schema';
import { FrameworkExecutionResult, FrameworkMetrics } from './types';

/**
 * Interface comum para todos os frameworks de produto.
 * Define o contrato que cada framework deve implementar.
 */
export interface IFramework {
  /**
   * Identificador único do framework
   */
  id: string;

  /**
   * Nome do framework
   */
  name: string;

  /**
   * Descrição do framework
   */
  description: string;

  /**
   * Tipo do framework
   */
  type: string;

  /**
   * Versão do framework
   */
  version: string;

  /**
   * Data de criação
   */
  createdAt: string;

  /**
   * Data da última atualização
   */
  updatedAt: string;

  /**
   * Executa o framework para uma demanda específica
   *
   * @param demand - A demanda a ser processada
   * @param onProgress - Callback opcional para reportar progresso
   * @returns Resultado da execução do framework
   */
  execute(
    demand: Demand,
    onProgress?: (progress: number, message: string) => void,
  ): Promise<FrameworkExecutionResult>;

  /**
   * Valida se o framework está configurado corretamente
   *
   * @returns true se válido, false caso contrário
   */
  validate(): boolean;

  /**
   * Retorna as métricas do framework
   *
   * @returns Métricas do framework
   */
  getMetrics(): FrameworkMetrics;
}
