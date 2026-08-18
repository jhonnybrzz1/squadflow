/**
 * Spec 10007 FR-001/010 — assina a conclusão do refinamento e dispara o
 * auto-commit do handoff. Fire-and-forget e fail-safe: um erro aqui NUNCA
 * derruba a aplicação nem afeta o fluxo de conclusão da demanda.
 */
import { eventBus, type OrchestrationEvent } from '../events/event-bus';
import { generateAndCommit } from './handoff-service';
import { logger } from '../utils/logger';

let registered = false;

/** Idempotente: chamar múltiplas vezes registra o handler uma única vez. */
export function registerHandoffAutoCommitSubscriber(): void {
  if (registered) return;
  registered = true;

  eventBus.subscribe<OrchestrationEvent>('ORCHESTRATION_COMPLETED', (event) => {
    // Não await: fire-and-forget para não bloquear o pipeline de conclusão.
    void generateAndCommit(event.demandId).catch((err) => {
      logger.error('Handoff auto-commit: falha não tratada no subscriber', {
        error: err instanceof Error ? err : undefined,
        context: { demandId: event.demandId },
      });
    });
  });
}
