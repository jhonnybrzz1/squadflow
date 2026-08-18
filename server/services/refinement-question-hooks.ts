/**
 * Refinement Question Hooks
 *
 * Decide quando o agente deve fazer perguntas ao PO durante o refinamento,
 * usando heurísticas simples sobre a demanda.
 *
 * Comportamento:
 * - Opt-in via env var REFINEMENT_INTERACTIVE_QUESTIONS_ENABLED=true
 * - Timeout configurável via REFINEMENT_QUESTION_TIMEOUT_MS (default: 60s)
 * - Em timeout ou erro, retorna null (fluxo continua sem resposta)
 *
 * Hooks atuais:
 * - askIfDescriptionTooShort: descrição curta + nova_funcionalidade → foco?
 * - askIfBugMissingExpectedBehavior: bug sem "esperado/atual" → comportamentos?
 * - askIfCriticalWithoutDeadline: prioridade crítica sem menção a prazo → prazo?
 */

import { logger } from '../utils/logger';
import { refinementInteractionService } from './refinement-interaction';
import type { Demand } from '@shared/schema';

const SHORT_DESCRIPTION_THRESHOLD_WORDS = 30;
const DEFAULT_TIMEOUT_MS = 60_000;

function isEnabled(): boolean {
  return process.env.REFINEMENT_INTERACTIVE_QUESTIONS_ENABLED === 'true';
}

function getTimeout(): number {
  const v = process.env.REFINEMENT_QUESTION_TIMEOUT_MS;
  return v ? parseInt(v, 10) : DEFAULT_TIMEOUT_MS;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function mentionsAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

/**
 * Resultado de uma pergunta opcional. `null` = não perguntou ou timeout.
 */
export interface QuestionResult {
  asked: boolean;
  questionId?: string;
  answer?: string;
  reason: string; // por que perguntou (ou não)
}

/**
 * Helper interno: emite pergunta com timeout, captura erros e retorna null em falha.
 */
async function safeAsk(
  refinementId: string,
  question: string,
  options: string[] | undefined,
  reason: string,
): Promise<QuestionResult> {
  if (!isEnabled()) {
    return { asked: false, reason: 'disabled_by_flag' };
  }
  try {
    const answer = await refinementInteractionService.askQuestion(
      refinementId,
      question,
      options,
      getTimeout(),
    );
    logger.info('Interactive question answered by PO', {
      context: { refinementId, reason, eventType: 'po_question_answered' },
    });
    return { asked: true, answer, reason };
  } catch (err) {
    const isTimeout = err instanceof Error && err.message.includes('timeout');
    logger.info('Interactive question skipped', {
      context: {
        refinementId,
        reason,
        skip: isTimeout ? 'timeout' : 'error',
        eventType: 'po_question_skipped',
      },
    });
    return { asked: false, reason: isTimeout ? 'timeout' : 'error' };
  }
}

/**
 * Hook: pergunta foco se descrição curta + nova_funcionalidade.
 */
export async function askIfDescriptionTooShort(demand: Demand): Promise<QuestionResult> {
  if (demand.type !== 'nova_funcionalidade') {
    return { asked: false, reason: 'not_new_feature' };
  }
  if (wordCount(demand.description) >= SHORT_DESCRIPTION_THRESHOLD_WORDS) {
    return { asked: false, reason: 'description_long_enough' };
  }
  return safeAsk(
    String(demand.id),
    'A descrição é curta. Qual deve ser o foco principal do refinamento?',
    ['Performance', 'Usabilidade', 'Integração com sistemas existentes', 'Cobertura funcional'],
    'short_description',
  );
}

/**
 * Hook: pergunta comportamento esperado/atual se bug não mencionar.
 */
export async function askIfBugMissingExpectedBehavior(demand: Demand): Promise<QuestionResult> {
  if (demand.type !== 'bug') {
    return { asked: false, reason: 'not_bug' };
  }
  const hasExpected = mentionsAny(demand.description, [
    'esperado',
    'esperava',
    'deveria',
    'expected',
  ]);
  const hasActual = mentionsAny(demand.description, ['atual', 'aconteceu', 'observado', 'actual']);
  if (hasExpected && hasActual) {
    return { asked: false, reason: 'expected_and_actual_present' };
  }
  return safeAsk(
    String(demand.id),
    'O bug não descreve comportamento esperado vs atual. Você pode esclarecer?',
    undefined,
    'bug_missing_behavior',
  );
}

/**
 * Hook: pergunta prazo se prioridade crítica sem menção a deadline.
 */
export async function askIfCriticalWithoutDeadline(demand: Demand): Promise<QuestionResult> {
  if (demand.priority !== 'critica') {
    return { asked: false, reason: 'not_critical' };
  }
  const mentionsDeadline = mentionsAny(demand.description, [
    'prazo',
    'deadline',
    'até',
    'antes de',
    'urgência',
    'urgente',
  ]);
  if (mentionsDeadline) {
    return { asked: false, reason: 'deadline_mentioned' };
  }
  return safeAsk(
    String(demand.id),
    'Esta demanda é crítica. Há um prazo específico para entrega?',
    ['Hoje', 'Esta semana', 'Próximas 2 semanas', 'Sem prazo definido'],
    'critical_no_deadline',
  );
}

/**
 * Executa todos os hooks aplicáveis em sequência.
 * Cada pergunta tem timeout independente; em timeout, prossegue sem bloquear.
 *
 * Retorna lista de resultados (úteis para logging/auditoria).
 */
export async function runClarificationHooks(demand: Demand): Promise<QuestionResult[]> {
  if (!isEnabled()) {
    return [{ asked: false, reason: 'disabled_by_flag' }];
  }

  const results: QuestionResult[] = [];
  results.push(await askIfDescriptionTooShort(demand));
  results.push(await askIfBugMissingExpectedBehavior(demand));
  results.push(await askIfCriticalWithoutDeadline(demand));

  const askedCount = results.filter((r) => r.asked).length;
  logger.info('Clarification hooks completed', {
    context: {
      demandId: demand.id,
      askedCount,
      hookResults: results.map((r) => ({ asked: r.asked, reason: r.reason })),
      eventType: 'clarification_hooks_completed',
    },
  });

  return results;
}
