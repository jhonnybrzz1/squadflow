import { CAPABLE_MODEL, OPENROUTER_FALLBACK_MODEL } from './llm-model-router';

/**
 * Converts a request payload for OpenAI fallback.
 * Handles max_tokens vs max_completion_tokens conversion.
 *
 * @param requestPayload - Original request payload
 * @returns Payload adapted for OpenAI
 */
export function toOpenAIFallbackPayload(
  requestPayload: Record<string, unknown>,
): Record<string, unknown> {
  const fallbackPayload: Record<string, unknown> = {
    ...requestPayload,
    model: CAPABLE_MODEL,
  };

  if (fallbackPayload.max_tokens) {
    fallbackPayload.max_completion_tokens = fallbackPayload.max_tokens;
    delete fallbackPayload.max_tokens;
  }

  return fallbackPayload;
}

/**
 * Converts a request payload for OpenRouter fallback.
 * Handles max_completion_tokens vs max_tokens conversion.
 *
 * @param requestPayload - Original request payload
 * @returns Payload adapted for OpenRouter
 */
export function toOpenRouterFallbackPayload(
  requestPayload: Record<string, unknown>,
): Record<string, unknown> {
  const fallbackPayload: Record<string, unknown> = {
    ...requestPayload,
    model: OPENROUTER_FALLBACK_MODEL,
  };

  if (fallbackPayload.max_completion_tokens) {
    fallbackPayload.max_tokens = fallbackPayload.max_completion_tokens;
    delete fallbackPayload.max_completion_tokens;
  }

  return fallbackPayload;
}
