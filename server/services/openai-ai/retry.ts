/**
 * P3 — Fachada de retry/timeout para o módulo openai-ai.
 *
 * Delega ao llm-completion-service, que é a camada real de retry/fallback.
 * Este módulo existe para centralizar as constantes e helpers de retry
 * específicos da fachada OpenAI, reduzindo acoplamento com openai-ai.ts.
 */
import { createChatCompletionWithRetry, type CompletionContext } from '../llm-completion-service';
import { createFallbackBudget, createRequestBudget, disposeRequestBudget } from '../request-budget';

export const DEFAULT_BATCH_CONCURRENCY = 4;
export const MAX_BATCH_CONCURRENCY = 10;
export const DEFAULT_CHAT_TIMEOUT_MS = 120_000;

export type RetryableRequest<T> = () => Promise<T>;

export interface RetryOptions {
  retryAttempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

/**
 * Verifica se uma resposta gerada deve ser considerada falha de qualidade
 * (erro ou conteúdo vazio).
 */
export function isQualityFailure(error: unknown, content: string): boolean {
  if (error) return true;
  if (!content || content.trim().length === 0) return true;
  return false;
}

export {
  createChatCompletionWithRetry,
  CompletionContext,
  createFallbackBudget,
  createRequestBudget,
  disposeRequestBudget,
};
