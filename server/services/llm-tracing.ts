/**
 * LLM Observability Tracing Service
 *
 * Provides OpenTelemetry-style structured spans for LLM interactions,
 * enabling end-to-end observability of AI operations.
 *
 * Key features:
 * - Trace hierarchy (trace → span tree)
 * - Parent-child span relationships for multi-step agent flows
 * - Structured metadata (model, tokens, cost, latency)
 * - In-memory ring buffer with configurable capacity
 * - Query API for recent traces
 *
 * This does NOT depend on the OpenTelemetry SDK; it implements a
 * lightweight subset compatible with OTel span semantics.
 */

import { logger } from '../utils/logger';
import crypto from 'crypto';
import { featureFlags } from './feature-flags';
import { traceExporterService } from './trace-exporter';
import { traceSamplingService } from './trace-sampling';

// ============================================
// Types
// ============================================

export type SpanStatus = 'ok' | 'error' | 'cancelled';

export interface SpanAttributes {
  operation: string;
  model: string;
  provider: string;
  agentName?: string;
  demandId?: number;
  requestId?: string;
  parentSpanId?: string;
  input?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SpanEndOptions {
  status: SpanStatus;
  output?: Record<string, unknown>;
  error?: string;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  estimatedCostUsd?: number;
}

export interface LlmSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  operation: string;
  model: string;
  provider: string;
  agentName: string | null;
  demandId: number | null;
  requestId: string | null;
  status: SpanStatus | 'in_progress';
  startedAt: number; // epoch ms
  endedAt: number | null; // epoch ms
  durationMs: number | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  estimatedCostUsd: number | null;
  attributes: Record<string, unknown>;
}

export interface TraceGroup {
  traceId: string;
  rootSpan: LlmSpan;
  spans: LlmSpan[];
  totalDurationMs: number;
  totalTokens: number;
  totalCostUsd: number;
  spanCount: number;
  status: SpanStatus;
}

export interface TracingStats {
  enabled: boolean;
  activeSpans: number;
  completedSpans: number;
  bufferSize: number;
  maxBufferSize: number;
  traceCount: number;
  errorRate: number;
  avgDurationMs: number;
}

// ============================================
// Configuration
// ============================================

const MAX_BUFFER_SIZE = 500;
const SPAN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ============================================
// Service
// ============================================

class LlmTracingService {
  private readonly spans: Map<string, LlmSpan> = new Map();
  private readonly completedBuffer: LlmSpan[] = [];
  private readonly traceIndex: Map<string, Set<string>> = new Map(); // traceId → spanIds

  private totalCompleted = 0;
  private totalErrors = 0;
  private totalDurationMs = 0;

  /**
   * Start a new span for an LLM operation.
   */
  startSpan(attributes: SpanAttributes): LlmSpan {
    const spanId = this.generateId();
    const traceId = attributes.parentSpanId
      ? (this.getTraceIdForSpan(attributes.parentSpanId) ?? this.generateId())
      : this.generateId();

    const span: LlmSpan = {
      traceId,
      spanId,
      parentSpanId: attributes.parentSpanId ?? null,
      operation: attributes.operation,
      model: attributes.model,
      provider: attributes.provider,
      agentName: attributes.agentName ?? null,
      demandId: attributes.demandId ?? null,
      requestId: attributes.requestId ?? null,
      status: 'in_progress',
      startedAt: Date.now(),
      endedAt: null,
      durationMs: null,
      input: attributes.input ?? null,
      output: null,
      error: null,
      tokenUsage: null,
      estimatedCostUsd: null,
      attributes: this.extractCustomAttributes(attributes),
    };

    this.spans.set(spanId, span);

    // Index by trace
    if (!this.traceIndex.has(traceId)) {
      this.traceIndex.set(traceId, new Set());
    }
    this.traceIndex.get(traceId)!.add(spanId);

    return span;
  }

  /**
   * End a span with result data.
   */
  endSpan(spanId: string, options: SpanEndOptions): void {
    const span = this.spans.get(spanId);
    if (!span) {
      logger.warn('Attempted to end non-existent span', {
        context: { spanId },
      });
      return;
    }

    const now = Date.now();
    span.status = options.status;
    span.endedAt = now;
    span.durationMs = now - span.startedAt;
    span.output = options.output ?? null;
    span.error = options.error ?? null;
    span.tokenUsage = options.tokenUsage ?? null;
    span.estimatedCostUsd = options.estimatedCostUsd ?? null;

    // Move to completed buffer
    this.spans.delete(spanId);
    this.completedBuffer.push(span);
    this.totalCompleted++;
    this.totalDurationMs += span.durationMs;

    if (options.status === 'error') {
      this.totalErrors++;
    }

    // Export to Jaeger/Zipkin if feature flag is enabled
    try {
      let isEnabled = false;
      try {
        const flags = featureFlags.getFlags();
        isEnabled = flags.enableTraceExport === true;
      } catch (_e) {
        /* ignore */
      }

      if (isEnabled) {
        const decision = traceSamplingService.shouldSample({
          traceId: span.traceId,
          operation: span.operation,
          agentName: span.agentName ?? undefined,
          isError: options.status === 'error',
        });
        if (decision.sampled) {
          traceExporterService.enqueue(span);
        }
      }
    } catch (_) {
      /* non-fatal */
    }

    // Prune completed buffer if over capacity
    while (this.completedBuffer.length > MAX_BUFFER_SIZE) {
      const evicted = this.completedBuffer.shift();
      if (evicted) {
        const traceSpans = this.traceIndex.get(evicted.traceId);
        if (traceSpans) {
          traceSpans.delete(evicted.spanId);
          if (traceSpans.size === 0) {
            this.traceIndex.delete(evicted.traceId);
          }
        }
      }
    }
  }

  /**
   * Create a child span under an existing parent.
   */
  startChildSpan(parentSpanId: string, attributes: Omit<SpanAttributes, 'parentSpanId'>): LlmSpan {
    return this.startSpan({ ...attributes, parentSpanId } as SpanAttributes);
  }

  /**
   * Get a specific span by ID (active or completed).
   */
  getSpan(spanId: string): LlmSpan | null {
    return this.spans.get(spanId) ?? this.completedBuffer.find((s) => s.spanId === spanId) ?? null;
  }

  /**
   * Get all spans for a trace.
   */
  getTrace(traceId: string): TraceGroup | null {
    const spanIds = this.traceIndex.get(traceId);
    if (!spanIds || spanIds.size === 0) return null;

    const spans: LlmSpan[] = [];
    for (const id of spanIds) {
      const span = this.getSpan(id);
      if (span) spans.push(span);
    }

    if (spans.length === 0) return null;

    // Sort by start time
    spans.sort((a, b) => a.startedAt - b.startedAt);
    const rootSpan = spans.find((s) => !s.parentSpanId) ?? spans[0];

    const totalTokens = spans.reduce((sum, s) => sum + (s.tokenUsage?.totalTokens ?? 0), 0);
    const totalCostUsd = spans.reduce((sum, s) => sum + (s.estimatedCostUsd ?? 0), 0);
    const lastEnd = Math.max(...spans.map((s) => s.endedAt ?? Date.now()));
    const totalDurationMs = lastEnd - rootSpan.startedAt;

    const hasError = spans.some((s) => s.status === 'error');
    const allDone = spans.every((s) => s.status !== 'in_progress');
    const status: SpanStatus = hasError ? 'error' : allDone ? 'ok' : 'ok';

    return {
      traceId,
      rootSpan,
      spans,
      totalDurationMs,
      totalTokens,
      totalCostUsd,
      spanCount: spans.length,
      status,
    };
  }

  /**
   * Query recent completed spans, optionally filtered.
   */
  querySpans(options?: {
    operation?: string;
    model?: string;
    agentName?: string;
    status?: SpanStatus;
    limit?: number;
  }): LlmSpan[] {
    let result = [...this.completedBuffer];

    if (options?.operation) {
      result = result.filter((s) => s.operation === options.operation);
    }
    if (options?.model) {
      result = result.filter((s) => s.model.includes(options.model!));
    }
    if (options?.agentName) {
      result = result.filter((s) => s.agentName === options.agentName);
    }
    if (options?.status) {
      result = result.filter((s) => s.status === options.status);
    }

    // Most recent first
    result.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));

    const limit = options?.limit ?? 50;
    return result.slice(0, limit);
  }

  /**
   * Query recent traces (grouped spans).
   */
  queryTraces(options?: { limit?: number }): TraceGroup[] {
    const limit = options?.limit ?? 20;
    const traceIds = Array.from(this.traceIndex.keys());

    const traces: TraceGroup[] = [];
    for (const traceId of traceIds) {
      const trace = this.getTrace(traceId);
      if (trace) traces.push(trace);
    }

    // Most recent first
    traces.sort((a, b) => b.rootSpan.startedAt - a.rootSpan.startedAt);
    return traces.slice(0, limit);
  }

  /**
   * Get service statistics.
   */
  getStats(): TracingStats {
    return {
      enabled: true,
      activeSpans: this.spans.size,
      completedSpans: this.totalCompleted,
      bufferSize: this.completedBuffer.length,
      maxBufferSize: MAX_BUFFER_SIZE,
      traceCount: this.traceIndex.size,
      errorRate: this.totalCompleted > 0 ? this.totalErrors / this.totalCompleted : 0,
      avgDurationMs:
        this.totalCompleted > 0 ? Math.round(this.totalDurationMs / this.totalCompleted) : 0,
    };
  }

  /**
   * Cleanup stale in-progress spans (called periodically).
   */
  cleanupStaleSpans(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [spanId, span] of this.spans) {
      if (now - span.startedAt > SPAN_TIMEOUT_MS) {
        this.endSpan(spanId, {
          status: 'cancelled',
          error: 'Span timed out after 5 minutes',
        });
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Clear all data (for tests).
   */
  clear(): void {
    this.spans.clear();
    this.completedBuffer.length = 0;
    this.traceIndex.clear();
    this.totalCompleted = 0;
    this.totalErrors = 0;
    this.totalDurationMs = 0;
  }

  // ============================================
  // Private helpers
  // ============================================

  private generateId(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  private getTraceIdForSpan(spanId: string): string | null {
    // Check active spans
    const active = this.spans.get(spanId);
    if (active) return active.traceId;

    // Check completed spans
    const completed = this.completedBuffer.find((s) => s.spanId === spanId);
    return completed?.traceId ?? null;
  }

  private extractCustomAttributes(attrs: SpanAttributes): Record<string, unknown> {
    const known = new Set([
      'operation',
      'model',
      'provider',
      'agentName',
      'demandId',
      'requestId',
      'parentSpanId',
      'input',
    ]);
    const custom: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(attrs)) {
      if (!known.has(key)) {
        custom[key] = value;
      }
    }
    return custom;
  }
}

export const llmTracingService = new LlmTracingService();
