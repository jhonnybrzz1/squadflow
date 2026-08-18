import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================
// Mocks — vi.mock is hoisted; use inline vi.fn()
// ============================================================

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../server/metrics/collector', () => ({
  metricsCollector: {
    recordCacheHit: vi.fn(),
    recordCacheMiss: vi.fn(),
  },
}));

vi.mock('../server/services/embedding-service', () => {
  const getEmbedding = vi.fn();
  const cosineSimilarity = vi.fn();
  return {
    embeddingService: {
      getEmbedding,
      cosineSimilarity,
    },
  };
});

// ============================================================
// Imports (after mocks)
// ============================================================

import { SemanticCacheService } from '../server/services/semantic-cache';
import { llmTracingService } from '../server/services/llm-tracing';
import { embeddingService } from '../server/services/embedding-service';

// Typed references to the mocked functions
const mockGetEmbedding = embeddingService.getEmbedding as ReturnType<typeof vi.fn>;
const mockCosineSimilarity = embeddingService.cosineSimilarity as ReturnType<typeof vi.fn>;

// ============================================================
// Semantic Cache Tests
// ============================================================

const FP = 'fp-test';

describe('SemanticCacheService', () => {
  let cache: SemanticCacheService;

  beforeEach(() => {
    vi.clearAllMocks();
    cache = new SemanticCacheService({
      similarityThreshold: 0.92,
      maxEntries: 10,
      ttlMs: 60_000,
      enabled: true,
    });

    // Default mock: generate a unique embedding per text
    mockGetEmbedding.mockImplementation(async (text: string) => {
      const arr = new Array(128).fill(0);
      // Simple hash to create different embeddings for different texts
      for (let i = 0; i < text.length; i++) {
        arr[i % 128] += text.charCodeAt(i) / 1000;
      }
      return arr;
    });
  });

  describe('Basic operations', () => {
    it('should return null on empty cache', async () => {
      const result = await cache.get('hello', 'gpt-4', 'chat', FP);
      expect(result).toBeNull();
    });

    it('should store and retrieve by semantic similarity', async () => {
      const embedding = new Array(128).fill(0.5);
      mockGetEmbedding.mockResolvedValue(embedding);
      mockCosineSimilarity.mockReturnValue(0.95); // Above threshold

      await cache.set(
        'What is forex?',
        'Forex is foreign exchange...',
        'gpt-4',
        'chat',
        undefined,
        FP,
      );

      const result = await cache.get('Tell me about forex', 'gpt-4', 'chat', FP);
      expect(result).not.toBeNull();
      expect(result!.response).toBe('Forex is foreign exchange...');
      expect(result!.similarity).toBe(0.95);
    });

    it('should return null when similarity is below threshold', async () => {
      const embedding = new Array(128).fill(0.5);
      mockGetEmbedding.mockResolvedValue(embedding);

      await cache.set(
        'What is forex?',
        'Forex is foreign exchange...',
        'gpt-4',
        'chat',
        undefined,
        FP,
      );

      // Below threshold
      mockCosineSimilarity.mockReturnValue(0.85);
      const result = await cache.get('What is the weather?', 'gpt-4', 'chat', FP);
      expect(result).toBeNull();
    });

    it('should not cross-contaminate between different models', async () => {
      const embedding = new Array(128).fill(0.5);
      mockGetEmbedding.mockResolvedValue(embedding);
      mockCosineSimilarity.mockReturnValue(0.95);

      await cache.set('Hello', 'Response from GPT-4', 'gpt-4', 'chat', undefined, FP);

      const result = await cache.get('Hello', 'claude-3', 'chat', FP);
      expect(result).toBeNull();
    });

    it('should not cross-contaminate between different operations', async () => {
      const embedding = new Array(128).fill(0.5);
      mockGetEmbedding.mockResolvedValue(embedding);
      mockCosineSimilarity.mockReturnValue(0.95);

      await cache.set(
        'Hello',
        'Response for classification',
        'gpt-4',
        'classification',
        undefined,
        FP,
      );

      const result = await cache.get('Hello', 'gpt-4', 'analysis', FP);
      expect(result).toBeNull();
    });

    it('should return best match when multiple entries are similar', async () => {
      // Use different embeddings per call so set() dedup check sees low similarity
      let setCall = 0;
      mockGetEmbedding.mockImplementation(async () => {
        setCall++;
        return new Array(128).fill(setCall * 0.1);
      });

      // During set: dedup check returns low similarity so both entries are stored
      mockCosineSimilarity.mockReturnValue(0.5);
      await cache.set(
        'What is forex trading?',
        'Response A that is long enough for the cache',
        'gpt-4',
        'chat',
        undefined,
        FP,
      );
      await cache.set(
        'Explain currency exchange',
        'Response B that is long enough for the cache',
        'gpt-4',
        'chat',
        undefined,
        FP,
      );

      // On get, simulate: first entry has 0.93 similarity, second has 0.96
      let getCallCount = 0;
      mockCosineSimilarity.mockImplementation(() => {
        getCallCount++;
        return getCallCount === 1 ? 0.93 : 0.96;
      });

      const result = await cache.get('How does forex work?', 'gpt-4', 'chat', FP);
      expect(result).not.toBeNull();
      expect(result!.response).toBe('Response B that is long enough for the cache');
      expect(result!.similarity).toBe(0.96);
    });
  });

  describe('TTL and eviction', () => {
    it('should skip storing very short responses', async () => {
      mockGetEmbedding.mockResolvedValue(new Array(128).fill(0.5));
      await cache.set('Hello', 'Short', 'gpt-4', 'chat', undefined, FP);

      const stats = cache.getStats();
      expect(stats.size).toBe(0);
    });

    it('should skip storing empty responses', async () => {
      mockGetEmbedding.mockResolvedValue(new Array(128).fill(0.5));
      await cache.set('Hello', '', 'gpt-4', 'chat', undefined, FP);

      const stats = cache.getStats();
      expect(stats.size).toBe(0);
    });

    it('should evict when exceeding maxEntries', async () => {
      mockGetEmbedding.mockResolvedValue(new Array(128).fill(0.5));
      mockCosineSimilarity.mockReturnValue(0.5); // Not similar, so no dedup

      // Fill cache beyond max (10)
      for (let i = 0; i < 12; i++) {
        // Use a unique embedding per entry
        mockGetEmbedding.mockResolvedValue(new Array(128).fill(i * 0.1));
        await cache.set(
          `Query ${i}`,
          `This is a long enough response for entry number ${i} to pass the length check`,
          'gpt-4',
          'chat',
          undefined,
          FP,
        );
      }

      const stats = cache.getStats();
      expect(stats.size).toBeLessThanOrEqual(10);
    });

    it('should update existing entry when similarity is >= 0.98', async () => {
      mockGetEmbedding.mockResolvedValue(new Array(128).fill(0.5));
      mockCosineSimilarity.mockReturnValue(0.99); // Very similar = same entry

      await cache.set(
        'What is forex?',
        'Original response that is long enough',
        'gpt-4',
        'chat',
        undefined,
        FP,
      );
      await cache.set(
        'What is forex?',
        'Updated response that is long enough too',
        'gpt-4',
        'chat',
        undefined,
        FP,
      );

      const stats = cache.getStats();
      expect(stats.size).toBe(1); // Deduplicated
    });

    it('should clear all entries', async () => {
      mockGetEmbedding.mockResolvedValue(new Array(128).fill(0.5));
      mockCosineSimilarity.mockReturnValue(0.5);
      await cache.set(
        'Hello',
        'A sufficiently long response for the cache',
        'gpt-4',
        'chat',
        undefined,
        FP,
      );

      cache.clear();
      const stats = cache.getStats();
      expect(stats.size).toBe(0);
      expect(stats.totalHits).toBe(0);
      expect(stats.totalMisses).toBe(0);
    });
  });

  describe('Error handling', () => {
    it('should return null when embedding generation fails on get', async () => {
      mockGetEmbedding.mockResolvedValue(new Array(128).fill(0.5));
      mockCosineSimilarity.mockReturnValue(0.95);
      await cache.set(
        'Hello',
        'A sufficiently long response for the cache',
        'gpt-4',
        'chat',
        undefined,
        FP,
      );

      mockGetEmbedding.mockRejectedValue(new Error('Embedding service down'));
      const result = await cache.get('Hello', 'gpt-4', 'chat', FP);
      expect(result).toBeNull();
    });

    it('should silently skip storage when embedding fails on set', async () => {
      mockGetEmbedding.mockRejectedValue(new Error('Embedding service down'));
      await cache.set(
        'Hello',
        'A sufficiently long response for the cache',
        'gpt-4',
        'chat',
        undefined,
        FP,
      );

      const stats = cache.getStats();
      expect(stats.size).toBe(0);
      expect(stats.totalEmbeddingFailures).toBe(1);
    });

    it('should return null when disabled', async () => {
      const disabledCache = new SemanticCacheService({ enabled: false });
      const result = await disabledCache.get('Hello', 'gpt-4', 'chat');
      expect(result).toBeNull();
    });
  });

  describe('Stats', () => {
    it('should track hit rate correctly', async () => {
      mockGetEmbedding.mockResolvedValue(new Array(128).fill(0.5));
      mockCosineSimilarity.mockReturnValue(0.95);

      await cache.set(
        'Hello',
        'A sufficiently long response for the cache',
        'gpt-4',
        'chat',
        undefined,
        FP,
      );

      // Hit
      await cache.get('Hello', 'gpt-4', 'chat', FP);
      // Miss (different model)
      await cache.get('Hello', 'claude-3', 'chat', FP);

      const stats = cache.getStats();
      expect(stats.totalHits).toBe(1);
      expect(stats.totalMisses).toBe(1);
      expect(stats.hitRate).toBe(0.5);
    });

    it('should increment hit count on entry', async () => {
      mockGetEmbedding.mockResolvedValue(new Array(128).fill(0.5));
      mockCosineSimilarity.mockReturnValue(0.95);

      await cache.set(
        'Hello',
        'A sufficiently long response for the cache',
        'gpt-4',
        'chat',
        undefined,
        FP,
      );
      await cache.get('Hello again', 'gpt-4', 'chat', FP);
      await cache.get('Hello once more', 'gpt-4', 'chat', FP);

      const stats = cache.getStats();
      expect(stats.totalHits).toBe(2);
    });
  });
});

// ============================================================
// LLM Tracing Tests
// ============================================================

describe('LlmTracingService', () => {
  beforeEach(() => {
    llmTracingService.clear();
  });

  describe('Span lifecycle', () => {
    it('should create a span with correct attributes', () => {
      const span = llmTracingService.startSpan({
        operation: 'chat_completion',
        model: 'openai:gpt-4',
        provider: 'openai',
        agentName: 'refinador',
        demandId: 42,
        requestId: 'req-123',
      });

      expect(span.spanId).toBeTruthy();
      expect(span.traceId).toBeTruthy();
      expect(span.operation).toBe('chat_completion');
      expect(span.model).toBe('openai:gpt-4');
      expect(span.provider).toBe('openai');
      expect(span.agentName).toBe('refinador');
      expect(span.demandId).toBe(42);
      expect(span.status).toBe('in_progress');
      expect(span.startedAt).toBeGreaterThan(0);
      expect(span.endedAt).toBeNull();
    });

    it('should end a span with success', () => {
      const span = llmTracingService.startSpan({
        operation: 'chat_completion',
        model: 'openai:gpt-4',
        provider: 'openai',
      });

      llmTracingService.endSpan(span.spanId, {
        status: 'ok',
        output: { contentLength: 500 },
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        estimatedCostUsd: 0.005,
      });

      const completed = llmTracingService.getSpan(span.spanId);
      expect(completed).not.toBeNull();
      expect(completed!.status).toBe('ok');
      expect(completed!.endedAt).toBeGreaterThan(0);
      expect(completed!.durationMs).toBeGreaterThanOrEqual(0);
      expect(completed!.tokenUsage!.totalTokens).toBe(150);
      expect(completed!.estimatedCostUsd).toBe(0.005);
    });

    it('should end a span with error', () => {
      const span = llmTracingService.startSpan({
        operation: 'chat_completion',
        model: 'openai:gpt-4',
        provider: 'openai',
      });

      llmTracingService.endSpan(span.spanId, {
        status: 'error',
        error: 'Rate limit exceeded',
      });

      const completed = llmTracingService.getSpan(span.spanId);
      expect(completed).not.toBeNull();
      expect(completed!.status).toBe('error');
      expect(completed!.error).toBe('Rate limit exceeded');
    });

    it('should handle ending non-existent span gracefully', () => {
      expect(() => {
        llmTracingService.endSpan('non-existent-id', { status: 'ok' });
      }).not.toThrow();
    });
  });

  describe('Trace hierarchy', () => {
    it('should create child spans under a parent', () => {
      const parent = llmTracingService.startSpan({
        operation: 'agent_flow',
        model: 'openai:gpt-4',
        provider: 'openai',
      });

      const child1 = llmTracingService.startChildSpan(parent.spanId, {
        operation: 'classification',
        model: 'openai:gpt-4',
        provider: 'openai',
      });

      const child2 = llmTracingService.startChildSpan(parent.spanId, {
        operation: 'generation',
        model: 'openai:gpt-4',
        provider: 'openai',
      });

      // All should share same traceId
      expect(child1.traceId).toBe(parent.traceId);
      expect(child2.traceId).toBe(parent.traceId);
      expect(child1.parentSpanId).toBe(parent.spanId);
      expect(child2.parentSpanId).toBe(parent.spanId);
    });

    it('should build a complete trace from related spans', () => {
      const parent = llmTracingService.startSpan({
        operation: 'agent_flow',
        model: 'openai:gpt-4',
        provider: 'openai',
      });

      const child = llmTracingService.startChildSpan(parent.spanId, {
        operation: 'classification',
        model: 'openai:gpt-4',
        provider: 'openai',
      });

      llmTracingService.endSpan(child.spanId, {
        status: 'ok',
        tokenUsage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
        estimatedCostUsd: 0.002,
      });

      llmTracingService.endSpan(parent.spanId, {
        status: 'ok',
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        estimatedCostUsd: 0.005,
      });

      const trace = llmTracingService.getTrace(parent.traceId);
      expect(trace).not.toBeNull();
      expect(trace!.spanCount).toBe(2);
      expect(trace!.totalTokens).toBe(220); // 70 + 150
      expect(trace!.totalCostUsd).toBeCloseTo(0.007);
      expect(trace!.status).toBe('ok');
    });
  });

  describe('Query operations', () => {
    it('should query spans by operation', () => {
      const span1 = llmTracingService.startSpan({
        operation: 'classification',
        model: 'openai:gpt-4',
        provider: 'openai',
      });
      const span2 = llmTracingService.startSpan({
        operation: 'generation',
        model: 'openai:gpt-4',
        provider: 'openai',
      });

      llmTracingService.endSpan(span1.spanId, { status: 'ok' });
      llmTracingService.endSpan(span2.spanId, { status: 'ok' });

      const results = llmTracingService.querySpans({ operation: 'classification' });
      expect(results.length).toBe(1);
      expect(results[0].operation).toBe('classification');
    });

    it('should query spans by status', () => {
      const span1 = llmTracingService.startSpan({
        operation: 'chat',
        model: 'openai:gpt-4',
        provider: 'openai',
      });
      const span2 = llmTracingService.startSpan({
        operation: 'chat',
        model: 'openai:gpt-4',
        provider: 'openai',
      });

      llmTracingService.endSpan(span1.spanId, { status: 'ok' });
      llmTracingService.endSpan(span2.spanId, { status: 'error', error: 'fail' });

      const errors = llmTracingService.querySpans({ status: 'error' });
      expect(errors.length).toBe(1);
      expect(errors[0].error).toBe('fail');
    });

    it('should query spans by agentName', () => {
      const span1 = llmTracingService.startSpan({
        operation: 'chat',
        model: 'openai:gpt-4',
        provider: 'openai',
        agentName: 'refinador',
      });
      const span2 = llmTracingService.startSpan({
        operation: 'chat',
        model: 'openai:gpt-4',
        provider: 'openai',
        agentName: 'classificador',
      });

      llmTracingService.endSpan(span1.spanId, { status: 'ok' });
      llmTracingService.endSpan(span2.spanId, { status: 'ok' });

      const results = llmTracingService.querySpans({ agentName: 'refinador' });
      expect(results.length).toBe(1);
      expect(results[0].agentName).toBe('refinador');
    });

    it('should respect limit in queries', () => {
      for (let i = 0; i < 10; i++) {
        const span = llmTracingService.startSpan({
          operation: 'chat',
          model: 'openai:gpt-4',
          provider: 'openai',
        });
        llmTracingService.endSpan(span.spanId, { status: 'ok' });
      }

      const results = llmTracingService.querySpans({ limit: 3 });
      expect(results.length).toBe(3);
    });

    it('should query traces', () => {
      // Create two separate traces
      const span1 = llmTracingService.startSpan({
        operation: 'chat',
        model: 'openai:gpt-4',
        provider: 'openai',
      });
      llmTracingService.endSpan(span1.spanId, { status: 'ok' });

      const span2 = llmTracingService.startSpan({
        operation: 'analysis',
        model: 'openai:gpt-4',
        provider: 'openai',
      });
      llmTracingService.endSpan(span2.spanId, { status: 'ok' });

      const traces = llmTracingService.queryTraces();
      expect(traces.length).toBe(2);
    });
  });

  describe('Statistics', () => {
    it('should compute correct stats', () => {
      const span1 = llmTracingService.startSpan({
        operation: 'chat',
        model: 'openai:gpt-4',
        provider: 'openai',
      });
      const span2 = llmTracingService.startSpan({
        operation: 'chat',
        model: 'openai:gpt-4',
        provider: 'openai',
      });

      llmTracingService.endSpan(span1.spanId, { status: 'ok' });
      llmTracingService.endSpan(span2.spanId, { status: 'error', error: 'fail' });

      const stats = llmTracingService.getStats();
      expect(stats.completedSpans).toBe(2);
      expect(stats.activeSpans).toBe(0);
      expect(stats.errorRate).toBe(0.5);
      expect(stats.traceCount).toBe(2);
    });

    it('should track active spans', () => {
      llmTracingService.startSpan({
        operation: 'chat',
        model: 'openai:gpt-4',
        provider: 'openai',
      });

      const stats = llmTracingService.getStats();
      expect(stats.activeSpans).toBe(1);
    });
  });

  describe('Cleanup', () => {
    it('should clear all data', () => {
      const span = llmTracingService.startSpan({
        operation: 'chat',
        model: 'openai:gpt-4',
        provider: 'openai',
      });
      llmTracingService.endSpan(span.spanId, { status: 'ok' });

      llmTracingService.clear();
      const stats = llmTracingService.getStats();
      expect(stats.activeSpans).toBe(0);
      expect(stats.completedSpans).toBe(0);
      expect(stats.traceCount).toBe(0);
    });
  });

  describe('Input/output tracking', () => {
    it('should store input metadata on span', () => {
      const span = llmTracingService.startSpan({
        operation: 'chat',
        model: 'openai:gpt-4',
        provider: 'openai',
        input: { messageCount: 3, lastUserMessage: 'What is forex?' },
      });

      expect(span.input).toEqual({ messageCount: 3, lastUserMessage: 'What is forex?' });
    });

    it('should store output on span end', () => {
      const span = llmTracingService.startSpan({
        operation: 'chat',
        model: 'openai:gpt-4',
        provider: 'openai',
      });

      llmTracingService.endSpan(span.spanId, {
        status: 'ok',
        output: { contentLength: 1500 },
      });

      const completed = llmTracingService.getSpan(span.spanId);
      expect(completed!.output).toEqual({ contentLength: 1500 });
    });
  });

  describe('Null parent span', () => {
    it('should generate a new trace when parent does not exist', () => {
      const span = llmTracingService.startSpan({
        operation: 'chat',
        model: 'openai:gpt-4',
        provider: 'openai',
        parentSpanId: 'nonexistent-parent',
      });

      // Should still work, just generate a new traceId
      expect(span.traceId).toBeTruthy();
      expect(span.parentSpanId).toBe('nonexistent-parent');
    });
  });

  describe('getTrace edge cases', () => {
    it('should return null for non-existent trace', () => {
      const trace = llmTracingService.getTrace('non-existent-trace');
      expect(trace).toBeNull();
    });

    it('should report error status when any child has error', () => {
      const parent = llmTracingService.startSpan({
        operation: 'flow',
        model: 'openai:gpt-4',
        provider: 'openai',
      });

      const child = llmTracingService.startChildSpan(parent.spanId, {
        operation: 'step1',
        model: 'openai:gpt-4',
        provider: 'openai',
      });

      llmTracingService.endSpan(child.spanId, {
        status: 'error',
        error: 'step failed',
      });
      llmTracingService.endSpan(parent.spanId, { status: 'ok' });

      const trace = llmTracingService.getTrace(parent.traceId);
      expect(trace!.status).toBe('error');
    });
  });
});
