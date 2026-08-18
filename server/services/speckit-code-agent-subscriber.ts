/**
 * Spec 10044 T3 — assina `SPECKIT_COMPLETED` e dispara o agente de código.
 *
 * Fluxo: valida o manifest (contrato do speckit) ANTES de enfileirar; se
 * inválido, descarta o evento com log legível e NÃO dispara o agente (regra
 * 7.1). Se válido, enfileira o job no worker sequencial.
 *
 * SEGURANÇA — opt-in: espelhando `handoff-auto-commit-subscriber`, o disparo
 * real do Claude Code é gated por `AGENT_AUTORUN_ENABLED=true` (default OFF).
 * Sem a flag, o pipeline fica dormente — nunca spawna um processo por surpresa
 * no uso normal, em testes ou em produção-local. Isto é um kill-switch de
 * segurança, distinto do "feature flag de rollout" adiado (PRD §5.2).
 */
import { eventBus, type SpeckitCompletedPayload } from '../events/event-bus';
import { validateSpeckitManifest } from '@shared/handoff-manifest';
import { enqueueCodeAgentJob } from '../workers/code-agent-worker';
import { logger } from '../utils/logger';

let registered = false;

/** Liga o disparo automático apenas com a flag explicitamente em "true". */
export function isAutoRunEnabled(): boolean {
  return process.env.AGENT_AUTORUN_ENABLED === 'true';
}

/** Idempotente: registra o handler uma única vez. */
export function registerSpeckitCodeAgentSubscriber(): void {
  if (registered) return;
  registered = true;

  eventBus.subscribe<SpeckitCompletedPayload>('SPECKIT_COMPLETED', (payload) => {
    if (!isAutoRunEnabled()) {
      logger.debug('SPECKIT_COMPLETED ignorado: AGENT_AUTORUN_ENABLED != true', {
        context: { demandId: payload.demandId },
      });
      return;
    }

    // Validação pré-disparo (regra 7.1): manifest malformado descarta o evento.
    const validation = validateSpeckitManifest(payload.manifest);
    if (!validation.success) {
      logger.warn('SPECKIT_COMPLETED descartado: manifest inválido — agente não disparado', {
        context: { demandId: payload.demandId, errors: validation.errors },
      });
      return;
    }

    enqueueCodeAgentJob({
      demandId: payload.demandId,
      speckitPath: payload.specPath,
      prompt: payload.specContent,
    });
    logger.info('Agente de código enfileirado a partir de SPECKIT_COMPLETED', {
      context: { demandId: payload.demandId, specPath: payload.specPath },
    });
  });
}
