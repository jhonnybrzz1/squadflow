/**
 * Metrics Collector - Instrumentação MVP para Performance & Escalabilidade
 * Dia 1: Coleta de métricas mínimas para baseline e gate de decisão
 *
 * Métricas coletadas:
 * - http_duration_ms: Duração de requests HTTP por endpoint
 * - sse_first_event_latency_ms: Latência até primeiro evento SSE
 * - sse_events_per_connection: Número de eventos por conexão SSE
 * - sse_connection_lifetime_ms: Tempo de vida da conexão SSE
 * - cache_hit_rate: Taxa de hit/miss do cache in-memory
 * - openai_calls_per_request: Número de chamadas OpenAI por request
 * - openai_latency_ms: Latência de chamadas OpenAI
 */

// Prometheus tool metrics live in a side-effect-free module so callers can
// record them without instantiating this in-memory collector singleton.
export { toolExecutionDuration, toolExecutionTimeoutTotal } from './tool-execution';
export { githubContentIndexedTotal, githubContentIndexFailureTotal } from './github-content';

interface HTTPMetric {
  endpoint: string;
  method: string;
  statusCode: number;
  durationMs: number;
  timestamp: number;
  requestId?: string;
}

interface SSEMetric {
  demandId: number;
  firstEventLatencyMs: number;
  eventsPerConnection: number;
  connectionLifetimeMs: number;
  timestamp: number;
  requestId?: string;
}

interface CacheMetric {
  hits: number;
  misses: number;
  hitRate: number;
  timestamp: number;
}

interface OpenAIMetric {
  demandId?: number;
  callsPerRequest: number;
  latencyMs: number;
  model: string;
  timestamp: number;
  requestId?: string;
}

interface MemorySnapshot {
  heapUsed: number;
  heapTotal: number;
  external: number;
  timestamp: number;
  context?: string;
}

export class MetricsCollector {
  private httpMetrics: HTTPMetric[] = [];
  private sseMetrics: SSEMetric[] = [];
  private cacheMetrics: CacheMetric[] = [];
  private openaiMetrics: OpenAIMetric[] = [];
  private memorySnapshots: MemorySnapshot[] = [];

  private readonly MAX_METRICS_HISTORY = 10000;
  private readonly SAMPLING_INTERVAL_MS = 60000; // 1 minuto

  private samplingInterval?: NodeJS.Timeout;

  constructor() {
    this.startSampling();
  }

  // ============================================
  // HTTP Metrics
  // ============================================

  recordHTTP(
    endpoint: string,
    method: string,
    statusCode: number,
    durationMs: number,
    requestId?: string,
  ): void {
    this.httpMetrics.push({
      endpoint,
      method,
      statusCode,
      durationMs,
      timestamp: Date.now(),
      requestId,
    });

    this.pruneIfNeeded();
  }

  getHTTPMetrics(endpoint?: string, since?: number): HTTPMetric[] {
    let metrics = this.httpMetrics;

    if (endpoint) {
      metrics = metrics.filter((m) => m.endpoint === endpoint);
    }

    if (since) {
      metrics = metrics.filter((m) => m.timestamp >= since);
    }

    return metrics;
  }

  getHTTPDurationStats(
    endpoint?: string,
    since?: number,
  ): {
    p50: number;
    p95: number;
    p99: number;
    avg: number;
    count: number;
  } {
    const metrics = this.getHTTPMetrics(endpoint, since);
    const durations = metrics.map((m) => m.durationMs).sort((a, b) => a - b);

    if (durations.length === 0) {
      return { p50: 0, p95: 0, p99: 0, avg: 0, count: 0 };
    }

    const p50Index = Math.floor(durations.length * 0.5);
    const p95Index = Math.floor(durations.length * 0.95);
    const p99Index = Math.floor(durations.length * 0.99);

    const sum = durations.reduce((a, b) => a + b, 0);

    return {
      p50: durations[p50Index],
      p95: durations[p95Index],
      p99: durations[p99Index],
      avg: sum / durations.length,
      count: durations.length,
    };
  }

  // ============================================
  // SSE Metrics
  // ============================================

  recordSSEFirstEvent(demandId: number, firstEventLatencyMs: number, requestId?: string): void {
    // Find or create metric entry for this demand
    let metric = this.sseMetrics.find((m) => m.demandId === demandId && !m.connectionLifetimeMs);

    if (!metric) {
      metric = {
        demandId,
        firstEventLatencyMs,
        eventsPerConnection: 1,
        connectionLifetimeMs: 0, // 0 means still active
        timestamp: Date.now(),
        requestId,
      };
      this.sseMetrics.push(metric);
    } else {
      metric.firstEventLatencyMs = firstEventLatencyMs;
    }

    this.pruneIfNeeded();
  }

  recordSSEEvent(demandId: number): void {
    const metric = this.sseMetrics.find((m) => m.demandId === demandId && !m.connectionLifetimeMs);

    if (metric) {
      metric.eventsPerConnection += 1;
    }
  }

  recordSSEConnectionEnd(demandId: number): void {
    const metric = this.sseMetrics.find((m) => m.demandId === demandId && !m.connectionLifetimeMs);

    if (metric) {
      metric.connectionLifetimeMs = Date.now() - metric.timestamp;
    }
  }

  getSSEMetrics(since?: number): SSEMetric[] {
    if (since) {
      return this.sseMetrics.filter((m) => m.timestamp >= since);
    }
    return this.sseMetrics;
  }

  getSSEFirstEventStats(since?: number): {
    p50: number;
    p95: number;
    p99: number;
    avg: number;
    count: number;
  } {
    const metrics = this.getSSEMetrics(since).filter((m) => m.firstEventLatencyMs > 0);
    const latencies = metrics.map((m) => m.firstEventLatencyMs).sort((a, b) => a - b);

    if (latencies.length === 0) {
      return { p50: 0, p95: 0, p99: 0, avg: 0, count: 0 };
    }

    const p50Index = Math.floor(latencies.length * 0.5);
    const p95Index = Math.floor(latencies.length * 0.95);
    const p99Index = Math.floor(latencies.length * 0.99);

    const sum = latencies.reduce((a, b) => a + b, 0);

    return {
      p50: latencies[p50Index],
      p95: latencies[p95Index],
      p99: latencies[p99Index],
      avg: sum / latencies.length,
      count: latencies.length,
    };
  }

  // ============================================
  // Cache Metrics
  // ============================================

  recordCacheHit(): void {
    const latest = this.cacheMetrics[this.cacheMetrics.length - 1];
    if (latest && Date.now() - latest.timestamp < this.SAMPLING_INTERVAL_MS) {
      latest.hits += 1;
      latest.hitRate = latest.hits / (latest.hits + latest.misses);
    } else {
      this.cacheMetrics.push({
        hits: 1,
        misses: 0,
        hitRate: 1,
        timestamp: Date.now(),
      });
    }
  }

  recordCacheMiss(): void {
    const latest = this.cacheMetrics[this.cacheMetrics.length - 1];
    if (latest && Date.now() - latest.timestamp < this.SAMPLING_INTERVAL_MS) {
      latest.misses += 1;
      latest.hitRate = latest.hits / (latest.hits + latest.misses);
    } else {
      this.cacheMetrics.push({
        hits: 0,
        misses: 1,
        hitRate: 0,
        timestamp: Date.now(),
      });
    }
  }

  getCacheStats(since?: number): {
    totalHits: number;
    totalMisses: number;
    hitRate: number;
    samples: number;
  } {
    let metrics = this.cacheMetrics;

    if (since) {
      metrics = metrics.filter((m) => m.timestamp >= since);
    }

    const totalHits = metrics.reduce((sum, m) => sum + m.hits, 0);
    const totalMisses = metrics.reduce((sum, m) => sum + m.misses, 0);
    const totalRequests = totalHits + totalMisses;

    return {
      totalHits,
      totalMisses,
      hitRate: totalRequests > 0 ? totalHits / totalRequests : 0,
      samples: metrics.length,
    };
  }

  // ============================================
  // OpenAI Metrics
  // ============================================

  recordOpenAICall(
    demandId: number | undefined,
    latencyMs: number,
    model: string,
    requestId?: string,
  ): void {
    this.openaiMetrics.push({
      demandId,
      callsPerRequest: 1,
      latencyMs,
      model,
      timestamp: Date.now(),
      requestId,
    });

    this.pruneIfNeeded();
  }

  getOpenAIStats(since?: number): {
    totalCalls: number;
    avgLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    callsByModel: Record<string, number>;
  } {
    let metrics = this.openaiMetrics;

    if (since) {
      metrics = metrics.filter((m) => m.timestamp >= since);
    }

    if (metrics.length === 0) {
      return {
        totalCalls: 0,
        avgLatencyMs: 0,
        p50LatencyMs: 0,
        p95LatencyMs: 0,
        callsByModel: {},
      };
    }

    const latencies = metrics.map((m) => m.latencyMs).sort((a, b) => a - b);
    const p50Index = Math.floor(latencies.length * 0.5);
    const p95Index = Math.floor(latencies.length * 0.95);

    const callsByModel: Record<string, number> = {};
    metrics.forEach((m) => {
      callsByModel[m.model] = (callsByModel[m.model] || 0) + 1;
    });

    const sumLatency = latencies.reduce((a, b) => a + b, 0);

    return {
      totalCalls: metrics.length,
      avgLatencyMs: sumLatency / latencies.length,
      p50LatencyMs: latencies[p50Index],
      p95LatencyMs: latencies[p95Index],
      callsByModel,
    };
  }

  // ============================================
  // Memory Metrics
  // ============================================

  recordMemorySnapshot(context?: string): void {
    const usage = process.memoryUsage();

    this.memorySnapshots.push({
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      timestamp: Date.now(),
      context,
    });

    // Keep only last 1000 snapshots
    if (this.memorySnapshots.length > 1000) {
      this.memorySnapshots = this.memorySnapshots.slice(-1000);
    }
  }

  getMemoryStats(since?: number): {
    avgHeapUsed: number;
    maxHeapUsed: number;
    currentHeapUsed: number;
    snapshots: number;
  } {
    let snapshots = this.memorySnapshots;

    if (since) {
      snapshots = snapshots.filter((s) => s.timestamp >= since);
    }

    if (snapshots.length === 0) {
      return {
        avgHeapUsed: 0,
        maxHeapUsed: 0,
        currentHeapUsed: 0,
        snapshots: 0,
      };
    }

    const heapUsedValues = snapshots.map((s) => s.heapUsed);
    const sumHeapUsed = heapUsedValues.reduce((a, b) => a + b, 0);
    const maxHeapUsed = Math.max(...heapUsedValues);
    const currentHeapUsed = heapUsedValues[heapUsedValues.length - 1];

    return {
      avgHeapUsed: sumHeapUsed / heapUsedValues.length,
      maxHeapUsed,
      currentHeapUsed,
      snapshots: snapshots.length,
    };
  }

  // ============================================
  // Baseline & Export
  // ============================================

  exportBaseline(since?: number): Record<string, unknown> {
    return {
      timestamp: Date.now(),
      period: since ? { since, to: Date.now() } : 'all',
      http: {
        durationStats: this.getHTTPDurationStats(undefined, since),
        topEndpoints: this.getTopEndpoints(5, since),
      },
      sse: {
        firstEventStats: this.getSSEFirstEventStats(since),
        avgEventsPerConnection: this.getAvgEventsPerConnection(since),
        avgConnectionLifetime: this.getAvgConnectionLifetime(since),
      },
      cache: this.getCacheStats(since),
      openai: this.getOpenAIStats(since),
      memory: this.getMemoryStats(since),
    };
  }

  private getTopEndpoints(
    limit: number,
    since?: number,
  ): Array<{
    endpoint: string;
    count: number;
    avgDurationMs: number;
  }> {
    const metrics = this.getHTTPMetrics(undefined, since);
    const endpointMap = new Map<string, { count: number; totalDuration: number }>();

    metrics.forEach((m) => {
      const existing = endpointMap.get(m.endpoint) || {
        count: 0,
        totalDuration: 0,
      };
      existing.count += 1;
      existing.totalDuration += m.durationMs;
      endpointMap.set(m.endpoint, existing);
    });

    return Array.from(endpointMap.entries())
      .map(([endpoint, data]) => ({
        endpoint,
        count: data.count,
        avgDurationMs: data.totalDuration / data.count,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  private getAvgEventsPerConnection(since?: number): number {
    const metrics = this.getSSEMetrics(since).filter((m) => m.connectionLifetimeMs > 0);
    if (metrics.length === 0) return 0;

    const totalEvents = metrics.reduce((sum, m) => sum + m.eventsPerConnection, 0);
    return totalEvents / metrics.length;
  }

  private getAvgConnectionLifetime(since?: number): number {
    const metrics = this.getSSEMetrics(since).filter((m) => m.connectionLifetimeMs > 0);
    if (metrics.length === 0) return 0;

    const totalLifetime = metrics.reduce((sum, m) => sum + m.connectionLifetimeMs, 0);
    return totalLifetime / metrics.length;
  }

  // ============================================
  // Utilities
  // ============================================

  private startSampling(): void {
    // Record memory snapshot every minute
    this.samplingInterval = setInterval(() => {
      this.recordMemorySnapshot('periodic');
    }, this.SAMPLING_INTERVAL_MS);
  }

  private pruneIfNeeded(): void {
    if (this.httpMetrics.length > this.MAX_METRICS_HISTORY) {
      this.httpMetrics = this.httpMetrics.slice(-this.MAX_METRICS_HISTORY / 2);
    }

    if (this.sseMetrics.length > this.MAX_METRICS_HISTORY) {
      this.sseMetrics = this.sseMetrics.slice(-this.MAX_METRICS_HISTORY / 2);
    }

    if (this.openaiMetrics.length > this.MAX_METRICS_HISTORY) {
      this.openaiMetrics = this.openaiMetrics.slice(-this.MAX_METRICS_HISTORY / 2);
    }
  }

  clear(): void {
    this.httpMetrics = [];
    this.sseMetrics = [];
    this.cacheMetrics = [];
    this.openaiMetrics = [];
    this.memorySnapshots = [];
  }

  stop(): void {
    if (this.samplingInterval) {
      clearInterval(this.samplingInterval);
    }
  }
}

// Singleton instance
export const metricsCollector = new MetricsCollector();

// Cleanup on process exit
process.on('SIGTERM', () => {
  metricsCollector.stop();
});

process.on('SIGINT', () => {
  metricsCollector.stop();
});
