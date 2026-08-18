/**
 * Demanda 10209 — Fase 2: guardrails extraídos do god object openai-ai.ts.
 */
import { logger } from '../../utils/logger';
import {
  GUARDRAIL_UNAVAILABLE_MESSAGE,
  runGuardrailsOnMessagesAsync,
  shouldFailClosed,
} from '../llm-guardrails';
import { GuardrailBlockError } from './errors';
import type { AIChatMessage, GenerateOptions } from './types';

export interface GuardrailInput {
  messages: AIChatMessage[];
  options: GenerateOptions;
  requestId: string;
}

export async function applyGuardrails(input: GuardrailInput): Promise<AIChatMessage[]> {
  const { messages, options, requestId } = input;

  const guardrailResult = await runGuardrailsOnMessagesAsync(messages, {
    demandId: options.demandId,
    requestId,
    injectionShadow: options.injectionShadow === true,
    skipInjectionCheck: options.skipInjectionCheck === true,
    failOpenOnError: options.failOpenOnError === true,
    sensitiveOperation: options.sensitiveOperation === true,
  });

  if (guardrailResult.blocked) {
    logger.warn('Message blocked by guardrails', {
      context: {
        requestId,
        reason: guardrailResult.blockReason,
        detections: guardrailResult.totalDetections,
        latencyMs: guardrailResult.totalLatencyMs,
      },
    });
    throw new GuardrailBlockError(
      guardrailResult.userMessage || 'Mensagem bloqueada pelos guardrails de segurança.',
      guardrailResult.blockReason || 'unknown',
      guardrailResult.totalDetections,
    );
  }

  // Spec 012 (FR-009): proteção indisponível + operação sensível => fail-closed.
  if (shouldFailClosed(guardrailResult.verdict, options.sensitiveOperation === true)) {
    throw new GuardrailBlockError(
      GUARDRAIL_UNAVAILABLE_MESSAGE,
      'guardrails_unavailable',
      guardrailResult.totalDetections,
    );
  }

  return (guardrailResult.messages as AIChatMessage[]) ?? messages;
}
