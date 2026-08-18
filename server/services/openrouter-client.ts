/**
 * Shared OpenRouter client factory.
 *
 * Single cached instance per process. Each runtime module keeps its own
 * reset helper that delegates here so test isolation is preserved.
 */
import OpenAI from 'openai';

let cachedClient: OpenAI | null = null;

/**
 * Returns a lazily-created, cached OpenAI-compatible client pointed at
 * the OpenRouter API. Throws immediately if OPENROUTER_API_KEY is absent.
 *
 * @param callerName - Identifies which module is requesting the client,
 *   used only in the error message for easier debugging.
 */
export function getOpenRouterClient(callerName = 'runtime'): OpenAI {
  if (cachedClient) return cachedClient;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      `${callerName} requires OPENROUTER_API_KEY. Set the env variable or disable the feature flag.`,
    );
  }

  cachedClient = new OpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      ...(process.env.OPENROUTER_SITE_URL
        ? { 'HTTP-Referer': process.env.OPENROUTER_SITE_URL }
        : {}),
      ...(process.env.OPENROUTER_APP_NAME ? { 'X-Title': process.env.OPENROUTER_APP_NAME } : {}),
    },
  });

  return cachedClient;
}

/**
 * Clears the cached client. Call from test reset helpers so each suite
 * gets a fresh instance without cross-test pollution.
 */
export function resetOpenRouterClientCache(): void {
  cachedClient = null;
}
