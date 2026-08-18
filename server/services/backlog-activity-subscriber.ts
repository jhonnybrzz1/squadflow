import { resolvePath } from '@shared/utils/paths';
/**
 * Demanda 10096 — cria a atividade de backlog quando o refinamento conclui.
 *
 * Escuta ORCHESTRATION_COMPLETED (mesmo evento do handoff-auto-commit) e cria
 * a atividade. Fire-and-forget e fail-safe: um erro aqui NUNCA derruba a app
 * nem afeta a conclusão da demanda. Os "steps" (PRD/Tasks/Chat) são preenchidos
 * com fallback resiliente — o que não conseguir confirmar vira `false`, não erro.
 */
import fs from 'node:fs';

import { eventBus, type OrchestrationEvent } from '../events/event-bus';
import { backlogActivityService } from './backlog-activity-service';
import { demandRepository } from '../repositories/demand-repository';
import { logger } from '../utils/logger';

let registered = false;

/** Confirma o artefato por filesystem (documents/), com fallback silencioso. */
function hasDoc(prefix: string, demandId: number): boolean {
  try {
    const dir = resolvePath('documents');
    return fs.readdirSync(dir).some((f) => f.startsWith(`${prefix}_${demandId}_`));
  } catch (_) {
    return false;
  }
}

export function registerBacklogActivitySubscriber(): void {
  if (registered) return;
  registered = true;

  eventBus.subscribe<OrchestrationEvent>('ORCHESTRATION_COMPLETED', (event) => {
    void (async () => {
      const demand = await demandRepository.findByIdOrNull(event.demandId);
      if (!demand) return;
      await backlogActivityService.createFromHandoff({
        demandId: event.demandId,
        title: demand.title,
        hasPrd: hasDoc('PRD', event.demandId),
        hasTasks: hasDoc('Tasks', event.demandId),
        hasChat: Array.isArray(demand.chatMessages) && demand.chatMessages.length > 0,
      });
    })().catch((err) => {
      logger.error('Backlog activity: falha não tratada no subscriber', {
        error: err instanceof Error ? err : undefined,
        context: { demandId: event.demandId },
      });
    });
  });
}
