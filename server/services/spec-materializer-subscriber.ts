/**
 * FEAT-20260724-001 — materializa a spec do handoff quando o refinamento conclui.
 *
 * Escuta ORCHESTRATION_COMPLETED (mesmo evento do backlog-activity-subscriber).
 * Fire-and-forget e fail-safe: um erro aqui NUNCA derruba a app nem afeta a
 * conclusão da demanda. Idempotente pela própria regra do materializer (não
 * sobrescreve pasta existente).
 */
import { eventBus, type OrchestrationEvent } from '../events/event-bus';
import { materializeSpec } from './spec-materializer';
import { logger } from '../utils/logger';

let registered = false;

export function registerSpecMaterializerSubscriber(): void {
  if (registered) return;
  registered = true;

  eventBus.subscribe<OrchestrationEvent>('ORCHESTRATION_COMPLETED', (event) => {
    try {
      const r = materializeSpec(event.demandId);
      if (r.status === 'created') {
        logger.info('Spec materializada automaticamente', {
          context: { demandId: event.demandId, dir: r.dir, files: r.files },
        });
      }
    } catch (err) {
      logger.error('Spec materializer: falha não tratada no subscriber', {
        error: err instanceof Error ? err : undefined,
        context: { demandId: event.demandId },
      });
    }
  });
}
