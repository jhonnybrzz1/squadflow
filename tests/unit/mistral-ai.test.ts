import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MistralService, mistralService } from '../../server/services/mistral-ai';
import { circuitBreaker } from '../../server/services/circuit-breaker';

const VALID_RESPONSE = {
  id: 'test',
  object: 'chat.completion',
  created: Date.now(),
  model: 'mistral-medium-3.5',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'hello' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

vi.mock('../../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../server/services/ai-usage-tracker', () => ({
  aiUsageTracker: {
    record: vi.fn(),
  },
  estimateTextTokens: vi.fn((text: string) => text.length / 4),
  estimateCost: vi.fn().mockResolvedValue({
    listCostUsd: 0.0000125,
    billedCostUsd: null,
    creditAppliedUsd: null,
    pricingSource: 'static',
    pricingUpdatedAt: null,
    isEstimated: true,
  }),
}));

describe('MistralService circuit breaker integration', () => {
  let service: MistralService;

  beforeEach(() => {
    service = new MistralService('test-key');
    circuitBreaker.reset('mistral');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records success when the API responds', async () => {
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response(JSON.stringify(VALID_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    await service.generateChatCompletion('system', 'user');

    const stats = circuitBreaker.getStats('mistral');
    expect(stats.state).toBe('CLOSED');
    expect(stats.totalSuccesses).toBe(1);
    expect(stats.totalFailures).toBe(0);
  });

  it('records failure and opens circuit after repeated errors', async () => {
    vi.mocked(fetch).mockImplementation(
      async () => new Response('Internal Server Error', { status: 500 }),
    );

    const config = circuitBreaker['getConfig']('mistral');
    for (let i = 0; i < config.failureThreshold; i += 1) {
      await expect(service.generateChatCompletion('system', 'user')).rejects.toThrow(
        'Mistral API error: 500',
      );
    }

    const stats = circuitBreaker.getStats('mistral');
    expect(stats.state).toBe('OPEN');
    expect(stats.totalFailures).toBe(config.failureThreshold);
  });

  it('rejects immediately when circuit is OPEN', async () => {
    circuitBreaker.forceState('mistral', 'OPEN');
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response(JSON.stringify(VALID_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    await expect(service.generateChatCompletion('system', 'user')).rejects.toThrow(
      'Circuit breaker is OPEN',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('closes circuit after success threshold in HALF_OPEN', async () => {
    circuitBreaker.forceState('mistral', 'OPEN');
    circuitBreaker['getCircuit']('mistral').openedAt = new Date(Date.now() - 120_000);
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response(JSON.stringify(VALID_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    const config = circuitBreaker['getConfig']('mistral');
    for (let i = 0; i < config.successThreshold; i += 1) {
      await service.generateChatCompletion('system', 'user');
    }

    const stats = circuitBreaker.getStats('mistral');
    expect(stats.state).toBe('CLOSED');
    expect(stats.totalSuccesses).toBe(config.successThreshold);
  });
});

describe('mistralService singleton', () => {
  it('is configured with the default API key', () => {
    expect(mistralService).toBeInstanceOf(MistralService);
  });
});
