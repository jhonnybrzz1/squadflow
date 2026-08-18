import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockDbRun = vi.fn().mockResolvedValue(undefined);
const mockDbAll = vi.fn().mockResolvedValue([]);
const mockDbGet = vi.fn().mockResolvedValue(undefined);

vi.mock('../../server/db', () => ({
  isPostgres: false,
  db: {},
  dbHelper: {
    run: (...args: any[]) => mockDbRun(...args),
    all: (...args: any[]) => mockDbAll(...args),
    get: (...args: any[]) => mockDbGet(...args),
    isPostgres: false,
  },
}));

vi.mock('../../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('llm-metrics-collector', () => {
  const originalEnv = process.env.ENABLE_LLM_METRICS;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRun.mockResolvedValue(undefined);
    mockDbAll.mockResolvedValue([]);
    mockDbGet.mockResolvedValue(undefined);
    process.env.ENABLE_LLM_METRICS = 'true';
  });

  afterEach(() => {
    process.env.ENABLE_LLM_METRICS = originalEnv;
  });

  it('não grava quando ENABLE_LLM_METRICS=false', async () => {
    process.env.ENABLE_LLM_METRICS = 'false';
    const { LlmMetricsCollector } = await import('../../server/services/llm-metrics-collector');
    const collector = new LlmMetricsCollector();
    collector.record({ provider: 'openai', model: 'gpt-4o' });
    await collector.flush();
    expect(mockDbRun).not.toHaveBeenCalled();
  });

  it('grava registro com metadata e flush', async () => {
    const { LlmMetricsCollector } = await import('../../server/services/llm-metrics-collector');
    const collector = new LlmMetricsCollector();
    collector.record({
      provider: 'openai',
      model: 'gpt-4o',
      latencyMs: 100,
      errorFlag: false,
      cacheHit: false,
      costEstimate: 0.01,
      operationType: 'chat_completion',
      requestId: 'req-1',
      metadata: { source: 'test' },
    });
    await collector.flush();

    expect(mockDbRun).toHaveBeenCalled();
  });

  it('grava metadata nulo quando JSON é circular', async () => {
    const { LlmMetricsCollector } = await import('../../server/services/llm-metrics-collector');
    const collector = new LlmMetricsCollector();
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    collector.record({
      provider: 'openai',
      model: 'gpt-4o',
      metadata: circular,
    });
    await collector.flush();

    expect(mockDbRun).toHaveBeenCalled();
  });
});
