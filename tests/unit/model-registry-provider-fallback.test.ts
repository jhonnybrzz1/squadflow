import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Real hot-path regression test for the cross-provider fallback bug found in
 * the 2026-07-13 reaudit (CRIT-01, commit f5fb4e5): `applyModelRegistryOverride`
 * used to write the *primary* model's provider onto the shared
 * `options.provider` field, which then leaked into resolving the *fallback*
 * model's provider — e.g. a Xiaomi-native primary (`mimo-v2.5-pro`) falling
 * back to a DeepSeek/Tencent id (`deepseek/deepseek-v4-pro`) would still
 * try to send the DeepSeek id to the Xiaomi client.
 *
 * This drives `OpenAIService.generateChatCompletionWithMessagesAndMetadata`
 * end-to-end (real `applyAgentModelPolicy`, `applyModelRegistryOverride`,
 * `resolveProvider`, `routingManager`) with the actual `product_manager`
 * agent policy (Xiaomi primary / DeepSeek fallback — the exact pairing from
 * the audit's reproduction), only mocking the network-facing seams
 * (`llmClientManager`, `createChatCompletionWithRetry`) and side-effect-only
 * services (cache, tracking, audit log, telemetry, guardrails).
 */

const getClient = vi.fn((provider: string) => ({ __provider: provider }));

vi.mock('../../server/services/llm-client-manager', () => ({
  llmClientManager: {
    getClient,
    hasClient: vi.fn(() => true),
    isProviderAvailable: vi.fn(() => true),
  },
}));

const createChatCompletionWithRetry = vi.fn();
vi.mock('../../server/services/llm-completion-service', () => ({
  createChatCompletionWithRetry,
}));

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../../server/utils/logger', () => ({ logger: loggerMocks }));

vi.mock('../../server/services/ai-cache', () => ({
  DEFAULT_CACHE_KEY_VERSION: 'v1',
  aiResponseCache: {
    createKey: vi.fn(() => 'test-cache-key'),
    get: vi.fn(() => null),
    set: vi.fn(),
  },
}));

vi.mock('../../server/services/semantic-cache', () => ({
  semanticCacheService: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
  },
}));

vi.mock('../../server/services/llm-audit-log', () => ({
  llmAuditLogService: { record: vi.fn() },
}));

vi.mock('../../server/services/request-telemetry', () => ({
  requestTelemetryService: { recordEvent: vi.fn(async () => undefined) },
  isClassificationEnabled: vi.fn(() => false),
}));

vi.mock('../../server/services/llm-guardrails', () => ({
  runGuardrailsOnMessagesAsync: vi.fn(async (messages: unknown) => ({
    blocked: false,
    messages,
    blockReason: null,
    userMessage: null,
    totalDetections: [],
    totalLatencyMs: 0,
    semanticFlagged: false,
    verdict: 'benign',
  })),
  shouldFailClosed: vi.fn(() => false),
  GUARDRAIL_UNAVAILABLE_MESSAGE: 'guardrail indisponível',
}));

describe('Model Registry — cross-provider fallback (CRIT-01 reaudit)', () => {
  const ORIGINAL_ENABLED = process.env.MODEL_REGISTRY_ENABLED;

  beforeEach(() => {
    process.env.MODEL_REGISTRY_ENABLED = 'true';
    vi.clearAllMocks();
    createChatCompletionWithRetry.mockReset();
    getClient.mockImplementation((provider: string) => ({ __provider: provider }));
  });

  afterEach(() => {
    if (ORIGINAL_ENABLED === undefined) {
      delete process.env.MODEL_REGISTRY_ENABLED;
    } else {
      process.env.MODEL_REGISTRY_ENABLED = ORIGINAL_ENABLED;
    }
  });

  it('uses the DeepSeek family provider for the fallback, not the primary Xiaomi client', async () => {
    // product_manager policy: model=mimo-v2.5-pro (xiaomi), modelFallback=deepseek/deepseek-v4-pro
    // (tencent — the DeepSeek families are homologated to Tencent TokenHub).
    // `requestPayload` is a single mutable object reused/mutated in-place
    // across the primary→fallback switch, so snapshot each call's
    // (client, model) pair as it happens instead of reading it back from
    // `mock.calls` after the fact (which would see the final mutated state).
    const attempts: Array<{
      client: unknown;
      model: unknown;
      budget: { controller: AbortController; attemptsUsed: { count: number } };
      fallbackLevel: string;
    }> = [];
    createChatCompletionWithRetry.mockImplementation(
      async (
        client: unknown,
        payload: { model: unknown },
        context: {
          budget: { controller: AbortController; attemptsUsed: { count: number } };
          fallbackLevel: string;
        },
      ) => {
        attempts.push({
          client,
          model: payload.model,
          budget: context.budget,
          fallbackLevel: context.fallbackLevel,
        });
        if (attempts.length === 1) {
          throw new Error('xiaomi primary unavailable');
        }
        return {
          choices: [{ message: { content: 'fallback response' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      },
    );

    const { openAIService } = await import('../../server/services/openai-ai');

    const result = await openAIService.generateChatCompletionWithMessagesAndMetadata(
      [{ role: 'user', content: 'ping' }],
      { agentName: 'product_manager', cache: false, semanticCacheDisabled: true },
    );

    expect(result.content).toBe('fallback response');
    expect(result.metadata.fallbackUsed).toBe(true);
    expect(attempts).toHaveLength(2);

    // First (primary) attempt: Xiaomi client + Xiaomi-native model id.
    expect(attempts[0]).toMatchObject({
      client: { __provider: 'xiaomi' },
      model: 'mimo-v2.5-pro',
      fallbackLevel: 'primary',
    });

    // Second (fallback) attempt: MUST use the DeepSeek family's own provider
    // (Tencent) and its normalized model id — not the Xiaomi client the
    // primary attempt used.
    expect(attempts[1]).toMatchObject({
      client: { __provider: 'tencent' },
      model: 'deepseek-v4-pro-202606',
      fallbackLevel: 'explicit',
    });
    expect(attempts[1].budget.controller).not.toBe(attempts[0].budget.controller);
    expect(attempts[1].budget.attemptsUsed).toBe(attempts[0].budget.attemptsUsed);

    expect(getClient).toHaveBeenNthCalledWith(1, 'xiaomi');
    expect(getClient).toHaveBeenNthCalledWith(2, 'tencent');
  });

  it('still uses the Xiaomi client for the primary attempt when it succeeds (no regression)', async () => {
    createChatCompletionWithRetry.mockResolvedValueOnce({
      choices: [{ message: { content: 'primary response' } }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    });

    const { openAIService } = await import('../../server/services/openai-ai');

    const result = await openAIService.generateChatCompletionWithMessagesAndMetadata(
      [{ role: 'user', content: 'ping' }],
      { agentName: 'product_manager', cache: false, semanticCacheDisabled: true },
    );

    expect(result.content).toBe('primary response');
    expect(result.metadata.fallbackUsed).toBe(false);
    expect(createChatCompletionWithRetry).toHaveBeenCalledTimes(1);
    expect(getClient).toHaveBeenCalledWith('xiaomi');
    expect(loggerMocks.info).toHaveBeenCalledWith(
      'LLM operation completed',
      expect.objectContaining({
        context: expect.objectContaining({
          requestId: expect.any(String),
          operation: expect.any(String),
          durationMs: expect.any(Number),
          model: expect.any(String),
          provider: 'xiaomi',
          fallbackUsed: false,
          fallbackLevel: 'primary',
        }),
      }),
    );
  });

  it('uses the explicit fallback when the primary model returns empty content', async () => {
    const attempts: Array<{
      client: unknown;
      model: unknown;
      fallbackLevel: string;
    }> = [];

    createChatCompletionWithRetry.mockImplementation(
      async (client: unknown, payload: { model: unknown }, context: { fallbackLevel: string }) => {
        attempts.push({
          client,
          model: payload.model,
          fallbackLevel: context.fallbackLevel,
        });
        if (attempts.length === 1) {
          return {
            choices: [{ message: { content: '' } }],
            usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
          };
        }
        return {
          choices: [{ message: { content: '{"descricao_reformulada":"ok"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
        };
      },
    );

    const { openAIService } = await import('../../server/services/openai-ai');

    const result = await openAIService.generateChatCompletionWithMessagesAndMetadata(
      [{ role: 'user', content: 'ping' }],
      { cache: false, semanticCacheDisabled: true, responseFormat: 'json_object' },
    );

    expect(result.content).toBe('{"descricao_reformulada":"ok"}');
    expect(result.metadata.fallbackUsed).toBe(true);
    expect(result.metadata.fallbackReason).toBe('explicit_model_empty_response');
    expect(attempts).toEqual([
      {
        client: { __provider: 'tencent' },
        model: 'deepseek-v4-flash-202605',
        fallbackLevel: 'primary',
      },
      {
        client: { __provider: 'mistral' },
        model: 'mistral-medium-3.5',
        fallbackLevel: 'explicit',
      },
    ]);
  });

  it('logs request id, duration and fallback stage on terminal errors', async () => {
    createChatCompletionWithRetry.mockRejectedValue(new Error('provider unavailable'));

    const { openAIService } = await import('../../server/services/openai-ai');

    await expect(
      openAIService.generateChatCompletionWithMessagesAndMetadata(
        [{ role: 'user', content: 'ping' }],
        {
          model: 'gpt-5.4-mini',
          provider: 'openai',
          cache: false,
          semanticCacheDisabled: true,
        },
      ),
    ).rejects.toThrow('provider unavailable');

    expect(loggerMocks.error).toHaveBeenCalledWith(
      'Sanitized LLM error',
      expect.objectContaining({
        message: expect.any(String),
        requestId: expect.any(String),
        durationMs: expect.any(Number),
        fallbackUsed: true,
        fallbackLevel: 'explicit',
      }),
    );
  });
});
