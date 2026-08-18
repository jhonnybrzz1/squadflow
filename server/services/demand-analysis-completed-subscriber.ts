import { eventBus } from '../events/event-bus';
import { demandRepository } from '../repositories/demand-repository';
import { logger } from '../utils/logger';

/**
 * Subscrição fire-and-forget do evento DEMAND_ANALYSIS_COMPLETED.
 *
 * Persiste o resultado da classificação na demanda. O evento é emitido pelo
 * DemandClassifier toda vez que uma análise é concluída; esta subscrição
 * garante que o resultado não fique apenas em memória/resposta HTTP.
 * Falhas são logadas e NÃO derrubam o classificador.
 */
export function registerDemandAnalysisCompletedSubscriber(): void {
  eventBus.subscribe<{ demandId: number; classification: unknown; timestamp?: string }>(
    'DEMAND_ANALYSIS_COMPLETED',
    async (payload) => {
      const { demandId, classification } = payload;

      logger.info('[DemandAnalysisCompletedSubscriber] Análise concluída', {
        context: { demandId },
      });

      if (!classification) {
        return;
      }

      try {
        await demandRepository.update(demandId, {
          classification,
          // Avança o progresso para indicar que a análise cognitiva terminou.
          // O processamento real continuará via agent-orchestrator.
          progress: 20,
        });
      } catch (err) {
        logger.warn('Failed to persist classification after DEMAND_ANALYSIS_COMPLETED', {
          error: err instanceof Error ? err : undefined,
          context: { demandId },
        });
      }
    },
  );
}
