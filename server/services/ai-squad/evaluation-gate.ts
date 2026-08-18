/**
 * Spec 10015 — Gate do modo Go-Live (fast-track).
 *
 * Centraliza a decisão de PULAR etapas de validação NÃO críticas quando a demanda
 * está em `goLiveMode`. Etapas críticas (schema Zod, autenticação, erros de API)
 * NUNCA são puladas — só as caras e não críticas (RAG quality, content guardrails).
 *
 * Sem AsyncLocalStorage: o `goLiveMode` é lido diretamente da demanda (que já é
 * passada pelo pipeline). Se o campo estiver ausente/undefined, o comportamento é o
 * pipeline COMPLETO (fail-safe — go-live é opt-in explícito).
 */
import { logger } from '../../utils/logger';

export type NonCriticalStage = 'rag_quality' | 'content_guardrails';

/** Etapas não críticas elegíveis para skip em go-live. */
export const NON_CRITICAL_STAGES: readonly NonCriticalStage[] = [
  'rag_quality',
  'content_guardrails',
];

/** `true` apenas quando a demanda está explicitamente em go-live. */
export function isGoLive(demand: { goLiveMode?: boolean | null } | null | undefined): boolean {
  return demand?.goLiveMode === true;
}

/**
 * Decide se uma etapa NÃO crítica deve ser pulada. Só pula se (a) go-live está
 * ligado E (b) a etapa está na lista de não críticas. Qualquer outra etapa roda.
 */
export function shouldSkipStage(
  stage: NonCriticalStage,
  goLiveMode: boolean | null | undefined,
): boolean {
  return goLiveMode === true && NON_CRITICAL_STAGES.includes(stage);
}

/** Log estruturado das etapas puladas (US2: observabilidade do fast-track). */
export function logSkippedStages(demandId: number, skippedStages: NonCriticalStage[]): void {
  if (skippedStages.length === 0) return;
  logger.info('Go-live: etapas não críticas puladas', {
    context: { demandId, goLiveMode: true, skippedStages },
  });
}
