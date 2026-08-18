/**
 * Demanda 10209 — barrel export do módulo openai-ai.
 *
 * Preserva a API pública atual enquanto refatora internamente para módulos coesos.
 */
export { OpenAIService, openAIService } from './openai-ai';

export {
  generateEmbedding,
  generateEmbeddings,
  isUsingLocalEmbeddings,
  isUsingLocalEmbeddingsForRAG,
} from './embeddings';

export { applyGuardrails } from './guardrails';

export type {
  CompletionOptions,
  NonStreamingCompletionOptions,
  StreamingCompletionOptions,
  StrictCompletionOptions,
  GuardrailProfile,
} from './completions';
export { resolveGuardrailProfile, getDefaultGuardrailProfile } from './completions';

export { GuardrailBlockError } from './errors';

export {
  type AIChatRole,
  type AIChatMessage,
  type GenerateOptions,
  type ChatCompletionMetadata,
  type ChatCompletionWithMetadata,
} from './types';

export { getLLMClient, hasLLMClient } from './client';

export {
  DEFAULT_BATCH_CONCURRENCY,
  MAX_BATCH_CONCURRENCY,
  DEFAULT_CHAT_TIMEOUT_MS,
  isQualityFailure,
  createChatCompletionWithRetry,
} from './retry';
export type { CompletionContext } from './retry';
