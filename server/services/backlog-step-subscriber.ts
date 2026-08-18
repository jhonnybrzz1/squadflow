/**
 * Demanda 10096 — atualização automática de steps do backlog quando artefatos
 * são gerados após a criação da atividade.
 *
 * O subscriber original (`backlog-activity-subscriber.ts`) captura o estado no
 * momento do handoff. PRD/Tasks são gerados assincronamente depois, via worker
 * de PDF, então este subscriber escuta `DOCUMENT_GENERATED` e atualiza as flags
 * `has_prd` / `has_tasks`. Chat já existe antes do handoff, então não precisa
 * de evento adicional aqui.
 */
import { eventBus } from '../events/event-bus';
import { backlogActivityService } from './backlog-activity-service';
import { logger } from '../utils/logger';

let registered = false;

export function registerBacklogStepSubscriber(): void {
  if (registered) return;
  registered = true;

  eventBus.subscribe<{ demandId: number; filepath: string; type?: string }>(
    'DOCUMENT_GENERATED',
    (event) => {
      void (async () => {
        const docType = (event.type || '').toUpperCase();
        const flags: { hasPrd?: boolean; hasTasks?: boolean } = {};
        if (docType === 'PRD') flags.hasPrd = true;
        else if (docType === 'TASKS') flags.hasTasks = true;
        else return;

        await backlogActivityService.updateArtifactFlags(event.demandId, flags);
      })().catch((err) => {
        logger.error('Backlog step: falha não tratada no subscriber', {
          error: err instanceof Error ? err : undefined,
          context: { demandId: event.demandId, type: event.type },
        });
      });
    },
  );
}

export function __resetBacklogStepSubscriberForTests(): void {
  registered = false;
}
