import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  canRequest: vi.fn(() => true),
  recordFailure: vi.fn(),
  recordSuccess: vi.fn(),
  isProviderAvailable: vi.fn(() => false),
  getClient: vi.fn(),
}));

vi.mock('../server/services/circuit-breaker', () => ({
  circuitBreaker: {
    canRequest: mocks.canRequest,
    recordFailure: mocks.recordFailure,
    recordSuccess: mocks.recordSuccess,
  },
}));

vi.mock('../server/services/llm-client-manager', () => ({
  llmClientManager: {
    isProviderAvailable: mocks.isProviderAvailable,
    getClient: mocks.getClient,
  },
}));

import { createChatCompletionWithRetry } from '../server/services/llm-completion-service';
import { createRequestBudget, disposeRequestBudget } from '../server/services/request-budget';

function clientWith(create: (...args: unknown[]) => unknown) {
  return {
    chat: { completions: { create: vi.fn(create) } },
  } as never;
}

describe('LLM completion budget and circuit breaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.canRequest.mockReturnValue(true);
    mocks.isProviderAvailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('não registra falha do provedor quando a janela local expira durante a chamada', async () => {
    const budget = createRequestBudget(120, 6, 60);
    const client = clientWith(async () => {
      vi.advanceTimersByTime(60);
      throw new DOMException('local timeout', 'AbortError');
    });

    await expect(
      createChatCompletionWithRetry(
        client,
        { model: 'test-model' },
        {
          operation: 'budget-test',
          model: 'test-model',
          provider: 'openai',
          retryAttempts: 1,
          budget,
          fallbackLevel: 'primary',
        },
      ),
    ).rejects.toThrow('local timeout');

    expect(mocks.recordFailure).not.toHaveBeenCalled();
    disposeRequestBudget(budget);
  });

  it('continua registrando falha real do provedor', async () => {
    const budget = createRequestBudget(120, 6, 60);
    const providerError = Object.assign(new Error('provider rejected request'), { status: 400 });
    const client = clientWith(async () => {
      throw providerError;
    });

    await expect(
      createChatCompletionWithRetry(
        client,
        { model: 'test-model' },
        {
          operation: 'provider-test',
          model: 'test-model',
          provider: 'openai',
          retryAttempts: 1,
          budget,
          fallbackLevel: 'primary',
        },
      ),
    ).rejects.toThrow('provider rejected request');

    expect(mocks.recordFailure).toHaveBeenCalledWith('openai', providerError);
    disposeRequestBudget(budget);
  });

  it('executa fallback de provider com nova janela após expirar a primária', async () => {
    const budget = createRequestBudget(120, 6, 60);
    const primary = clientWith(async () => {
      vi.advanceTimersByTime(60);
      throw new DOMException('primary timeout', 'AbortError');
    });
    const fallbackResponse = {
      choices: [{ message: { content: 'fallback ok' } }],
      model: 'fallback-model',
    };
    const fallback = clientWith(async () => fallbackResponse);

    mocks.isProviderAvailable.mockImplementation((provider) => provider === 'openrouter');
    mocks.getClient.mockReturnValue(fallback);

    await expect(
      createChatCompletionWithRetry(
        primary,
        { model: 'test-model' },
        {
          operation: 'fallback-test',
          model: 'test-model',
          provider: 'openai',
          retryAttempts: 1,
          budget,
          fallbackLevel: 'primary',
        },
      ),
    ).resolves.toBe(fallbackResponse);

    expect(fallback.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(budget.attemptsUsed.count).toBe(2);
    disposeRequestBudget(budget);
  });
});
