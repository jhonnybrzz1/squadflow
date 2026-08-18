/**
 * Demanda 10209 — barrel export que preserva a API pública de openai-ai.
 *
 * A implementação foi movida para o diretório `openai-ai/` com módulos coesos
 * (client, guardrails, embeddings, completions, errors, types).
 */
export * from './openai-ai/openai-ai';
export * from './openai-ai/embeddings';
export * from './openai-ai/guardrails';
export * from './openai-ai/completions';
export * from './openai-ai/errors';
export { getLLMClient, hasLLMClient } from './openai-ai/client';
export {
  DEFAULT_BATCH_CONCURRENCY,
  MAX_BATCH_CONCURRENCY,
  DEFAULT_CHAT_TIMEOUT_MS,
  isQualityFailure,
  createChatCompletionWithRetry,
} from './openai-ai/retry';
export type { CompletionContext } from './openai-ai/retry';
