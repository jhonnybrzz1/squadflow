import { eventBus } from '../events/event-bus';
import { demandRepository } from '../repositories/demand-repository';
import { logger } from '../utils/logger';

/**
 * Subscrição fire-and-forget do evento DOCUMENT_GENERATED.
 *
 * Atualiza a demanda com a URL pública do documento gerado (PRD/Tasks/TSD)
 * quando o worker de PDF finaliza. Falhas são logadas e NÃO derrubam o
 * pipeline de geração.
 */
export function registerDocumentGeneratedSubscriber(): void {
  eventBus.subscribe<{ demandId: number; filepath: string; type?: string }>(
    'DOCUMENT_GENERATED',
    async (payload) => {
      const { demandId, filepath, type } = payload;
      const docType = (type || '').toLowerCase();

      logger.info('[DocumentGeneratedSubscriber] Documento gerado', {
        context: { demandId, filepath, type: docType },
      });

      const filename = filepath.split('/').pop() || filepath;
      const publicUrl = `/api/documents/${filename}`;

      const updates: Record<string, unknown> = {};
      if (docType === 'prd' || docType === 'tsd' || filepath.toLowerCase().endsWith('_prd.pdf')) {
        updates.prdUrl = publicUrl;
      } else if (docType === 'tasks' || filepath.toLowerCase().endsWith('_tasks.pdf')) {
        updates.tasksUrl = publicUrl;
      } else {
        logger.warn('[DocumentGeneratedSubscriber] Tipo de documento não mapeado', {
          context: { demandId, filepath, type: docType },
        });
        return;
      }

      try {
        await demandRepository.update(demandId, updates);
      } catch (err) {
        logger.warn('Failed to update demand after DOCUMENT_GENERATED', {
          error: err instanceof Error ? err : undefined,
          context: { demandId, updates },
        });
      }
    },
  );
}
