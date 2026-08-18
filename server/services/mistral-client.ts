/**
 * Shared native Mistral client factory.
 *
 * Mistral tem chave própria (MISTRAL_API_KEY) e endpoint OpenAI-compatível em
 * https://api.mistral.ai/v1. Modelos Mistral (mistral-medium-*, mistral-small-*)
 * NUNCA passam pelo OpenRouter — usam esta conexão direta.
 *
 * Espelha `openrouter-client.ts`: instância única cacheada por processo, com
 * helper de reset para isolamento de testes.
 */
import OpenAI from 'openai';

const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';

let cachedClient: OpenAI | null = null;

export function createMistralClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey, baseURL: MISTRAL_BASE_URL, maxRetries: 0 });
}

/**
 * Returns a lazily-created, cached OpenAI-compatible client pointed at the
 * native Mistral API. Throws immediately if MISTRAL_API_KEY is absent.
 *
 * @param callerName - Identifies which module is requesting the client, used
 *   only in the error message for easier debugging.
 */
export function getMistralClient(callerName = 'runtime'): OpenAI {
  if (cachedClient) return cachedClient;

  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error(
      `${callerName} requires MISTRAL_API_KEY. Set the env variable or disable the feature flag.`,
    );
  }

  cachedClient = createMistralClient(apiKey);
  return cachedClient;
}
