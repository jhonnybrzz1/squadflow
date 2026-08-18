import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ============================================================
// Mocks — only mock dependencies, not the modules under test
// ============================================================

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../server/db', () => ({
  db: {
    execute: vi.fn().mockReturnValue({ changes: 1 }),
    all: vi.fn().mockResolvedValue([]),
    run: vi.fn(),
  },
  dbHelper: {
    run: vi.fn(),
    all: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
  },
  isPostgres: false,
}));

// ============================================================
// Imports
// ============================================================

import { TraceExporterService } from '../server/services/trace-exporter';
import { TraceSamplingService } from '../server/services/trace-sampling';
import { MemoryCacheStore } from '../server/services/cache-adapter';
import type { LlmSpan } from '../server/services/llm-tracing';

// ============================================================
// Helper: create a mock completed span
// ============================================================

function mockSpan(overrides?: Partial<LlmSpan>): LlmSpan {
  return {
    traceId: 'abc123def456789012345678901234ab',
    spanId: '1234567890abcdef',
    parentSpanId: null,
    operation: 'chat_completion',
    model: 'openai:gpt-4',
    provider: 'openai',
    agentName: 'refinador',
    demandId: 42,
    requestId: 'req-001',
    status: 'ok',
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    durationMs: 1000,
    input: { messageCount: 3 },
    output: { contentLength: 500 },
    error: null,
    tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    estimatedCostUsd: 0.005,
    attributes: {},
    ...overrides,
  };
}

// ============================================================
// Trace Exporter Tests
// ============================================================

describe('TraceExporterService', () => {
  let exporter: TraceExporterService;

  beforeEach(() => {
    exporter = new TraceExporterService();
    exporter.clear();
  });

  afterEach(() => {
    exporter.destroy();
  });

  it('should buffer spans for export', () => {
    exporter.enqueue(mockSpan());
    const stats = exporter.getStats();
    expect(stats.bufferSize).toBe(1);
  });

  it('should enqueue many spans', () => {
    exporter.enqueueMany([mockSpan(), mockSpan(), mockSpan()]);
    const stats = exporter.getStats();
    expect(stats.bufferSize).toBe(3);
  });

  it('should clear buffer and stats', () => {
    exporter.enqueue(mockSpan());
    exporter.clear();
    const stats = exporter.getStats();
    expect(stats.bufferSize).toBe(0);
    expect(stats.totalExported).toBe(0);
    expect(stats.totalFailed).toBe(0);
  });

  it('should flush empty buffer without errors', async () => {
    const count = await exporter.flush();
    expect(count).toBe(0);
  });

  it('should handle flush with network failure gracefully', async () => {
    // Mock fetch to fail
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    exporter.enqueue(mockSpan());
    const count = await exporter.flush();
    expect(count).toBe(0);

    const stats = exporter.getStats();
    expect(stats.totalFailed).toBe(1);

    globalThis.fetch = originalFetch;
  });

  it('should export spans successfully when endpoint responds OK', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    });

    exporter.enqueue(mockSpan());
    const count = await exporter.flush();
    expect(count).toBe(1);

    const stats = exporter.getStats();
    expect(stats.totalExported).toBe(1);
    expect(stats.totalBatches).toBe(1);
    expect(stats.lastExportAt).toBeGreaterThan(0);

    globalThis.fetch = originalFetch;
  });

  it('should report correct stats', () => {
    const stats = exporter.getStats();
    expect(stats.endpoint).toContain('localhost');
    expect(stats.batchSize).toBeGreaterThan(0);
    expect(stats.flushIntervalMs).toBeGreaterThan(0);
  });
});

// ============================================================
// Trace Sampling Tests
// ============================================================

describe('TraceSamplingService', () => {
  let sampler: TraceSamplingService;

  beforeEach(() => {
    sampler = new TraceSamplingService({ sampleRate: 1.0, enabled: true });
    sampler.clear();
  });

  it('should sample all requests at rate 1.0', () => {
    const decision = sampler.shouldSample({
      traceId: 'trace-1',
      operation: 'chat',
    });
    expect(decision.sampled).toBe(true);
    expect(decision.reason).toBe('rate');
  });

  it('should reject all requests at rate 0.0', () => {
    sampler = new TraceSamplingService({ sampleRate: 0, enabled: true });
    const decision = sampler.shouldSample({
      traceId: 'trace-1',
      operation: 'chat',
    });
    expect(decision.sampled).toBe(false);
    expect(decision.reason).toBe('rate');
  });

  it('should always sample errors when configured', () => {
    sampler = new TraceSamplingService({
      sampleRate: 0, // Sample nothing
      alwaysSampleErrors: true,
      enabled: true,
    });

    const decision = sampler.shouldSample({
      traceId: 'trace-1',
      operation: 'chat',
      isError: true,
    });
    expect(decision.sampled).toBe(true);
    expect(decision.reason).toBe('error');
  });

  it('should always sample priority operations', () => {
    sampler = new TraceSamplingService({
      sampleRate: 0, // Sample nothing
      priorityOperations: new Set(['agent_flow']),
      enabled: true,
    });

    const decision = sampler.shouldSample({
      traceId: 'trace-1',
      operation: 'agent_flow',
    });
    expect(decision.sampled).toBe(true);
    expect(decision.reason).toBe('priority_operation');
  });

  it('should always sample priority agents', () => {
    sampler = new TraceSamplingService({
      sampleRate: 0,
      priorityAgents: new Set(['refinador']),
      enabled: true,
    });

    const decision = sampler.shouldSample({
      traceId: 'trace-1',
      operation: 'chat',
      agentName: 'refinador',
    });
    expect(decision.sampled).toBe(true);
    expect(decision.reason).toBe('priority_agent');
  });

  it('should propagate parent trace decision', () => {
    // First decision for trace-1 (should be sampled at rate 1.0)
    sampler.shouldSample({ traceId: 'trace-1', operation: 'parent' });

    // Second span in same trace should inherit decision
    const childDecision = sampler.shouldSample({
      traceId: 'trace-1',
      operation: 'child',
    });
    expect(childDecision.sampled).toBe(true);
    expect(childDecision.reason).toBe('parent');
  });

  it('should return disabled when sampling is off', () => {
    sampler = new TraceSamplingService({ sampleRate: 1.0, enabled: false });
    const decision = sampler.shouldSample({
      traceId: 'trace-1',
      operation: 'chat',
    });
    expect(decision.sampled).toBe(false);
    expect(decision.reason).toBe('disabled');
  });

  it('should track stats correctly', () => {
    sampler.shouldSample({ traceId: 'trace-1', operation: 'chat' });
    sampler.shouldSample({ traceId: 'trace-2', operation: 'chat' });

    const stats = sampler.getStats();
    expect(stats.totalDecisions).toBe(2);
    expect(stats.sampledCount).toBe(2);
    expect(stats.effectiveSampleRate).toBe(1);
    expect(stats.configuredSampleRate).toBe(1);
  });

  it('should update config at runtime', () => {
    sampler.updateConfig({ sampleRate: 0.5 });
    const config = sampler.getConfig();
    expect(config.sampleRate).toBe(0.5);
  });

  it('should clamp sample rate between 0 and 1', () => {
    sampler.updateConfig({ sampleRate: 2.0 });
    expect(sampler.getConfig().sampleRate).toBe(1);

    sampler.updateConfig({ sampleRate: -0.5 });
    expect(sampler.getConfig().sampleRate).toBe(0);
  });

  it('should clear all state', () => {
    sampler.shouldSample({ traceId: 'trace-1', operation: 'chat' });
    sampler.clear();
    const stats = sampler.getStats();
    expect(stats.totalDecisions).toBe(0);
    expect(stats.sampledCount).toBe(0);
  });
});

// ============================================================
// Memory Cache Store Tests
// ============================================================

describe('MemoryCacheStore', () => {
  let store: MemoryCacheStore;

  beforeEach(() => {
    store = new MemoryCacheStore(10);
  });

  it('should get/set values', async () => {
    await store.set('key1', 'value1');
    const result = await store.get('key1');
    expect(result).toBe('value1');
  });

  it('should return null for missing keys', async () => {
    const result = await store.get('nonexistent');
    expect(result).toBeNull();
  });

  it('should respect TTL', async () => {
    await store.set('key1', 'value1', 50); // 50ms TTL
    const result1 = await store.get('key1');
    expect(result1).toBe('value1');

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 60));
    const result2 = await store.get('key1');
    expect(result2).toBeNull();
  });

  it('should delete keys', async () => {
    await store.set('key1', 'value1');
    await store.del('key1');
    const result = await store.get('key1');
    expect(result).toBeNull();
  });

  it('should clear all entries', async () => {
    await store.set('key1', 'value1');
    await store.set('key2', 'value2');
    await store.clear();

    expect(await store.get('key1')).toBeNull();
    expect(await store.get('key2')).toBeNull();
    expect(store.getStats().size).toBe(0);
  });

  it('should evict when exceeding max entries', async () => {
    for (let i = 0; i < 12; i++) {
      await store.set(`key${i}`, `value${i}`);
    }
    const stats = store.getStats();
    expect(stats.size).toBeLessThanOrEqual(10);
  });

  it('should track hit/miss stats', async () => {
    await store.set('key1', 'value1');
    await store.get('key1'); // hit
    await store.get('key2'); // miss

    const stats = store.getStats();
    expect(stats.totalHits).toBe(1);
    expect(stats.totalMisses).toBe(1);
    expect(stats.hitRate).toBe(0.5);
  });

  it('should report as ready', () => {
    expect(store.isReady()).toBe(true);
  });

  it('should report type as memory', () => {
    expect(store.getStats().type).toBe('memory');
  });

  it('should destroy cleanly', async () => {
    await store.set('key1', 'value1');
    await store.destroy();
    // After destroy, the store should still function but be empty
  });

  it('should handle entries with no expiry', async () => {
    await store.set('key1', 'value1'); // No TTL
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await store.get('key1');
    expect(result).toBe('value1');
  });
});
