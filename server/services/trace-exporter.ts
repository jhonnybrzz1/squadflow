/**
 * Trace Exporter — OTLP HTTP
 *
 * Exports LLM tracing spans to Jaeger/Zipkin-compatible backends
 * via the OpenTelemetry Protocol (OTLP) over HTTP/JSON.
 *
 * Architecture:
 * - Subscribes to completed spans from llmTracingService
 * - Batches spans in memory (configurable batch size + flush interval)
 * - Sends OTLP-formatted JSON to the configured collector endpoint
 * - Feature-flagged: only active when enableTraceExport is true
 * - Non-blocking: export failures never impact the main request path
 *
 * Compatible with:
 * - Jaeger (with OTLP HTTP receiver, typically :4318)
 * - Zipkin (via OTel Collector with Zipkin exporter)
 * - Any OTLP-compatible collector (Grafana Tempo, SigNoz, etc.)
 *
 * Env vars:
 * - OTEL_EXPORTER_OTLP_ENDPOINT  (default: http://localhost:4318)
 * - OTEL_EXPORTER_OTLP_HEADERS   (optional, comma-separated key=value)
 * - TRACE_EXPORT_BATCH_SIZE       (default: 20)
 * - TRACE_EXPORT_FLUSH_INTERVAL   (default: 5000ms)
 */

import { logger } from '../utils/logger';
import type { LlmSpan } from './llm-tracing';
import type { RAGSubstepTimings } from './rag-substep-metrics';
import { parseHeaders, parseBatchSize, parseFlushIntervalMs } from './trace-exporter-utils';

// ============================================
// OTLP Types (minimal subset for trace export)
// ============================================

interface OtlpResource {
  attributes: OtlpAttribute[];
}

interface OtlpAttributeValue {
  stringValue?: string;
  intValue?: number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpAttributeValue[] };
}

interface OtlpAttribute {
  key: string;
  value: OtlpAttributeValue;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number; // SPAN_KIND_INTERNAL = 1
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: number; message?: string }; // 0=UNSET, 1=OK, 2=ERROR
  events?: OtlpEvent[];
}

interface OtlpEvent {
  timeUnixNano: string;
  name: string;
  attributes: OtlpAttribute[];
}

interface OtlpScopeSpans {
  scope: { name: string; version: string };
  spans: OtlpSpan[];
}

interface OtlpResourceSpans {
  resource: OtlpResource;
  scopeSpans: OtlpScopeSpans[];
}

interface OtlpExportPayload {
  resourceSpans: OtlpResourceSpans[];
}

// ============================================
// Configuration
// ============================================

const DEFAULT_ENDPOINT = 'http://localhost:4318';
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const SERVICE_NAME = 'aichatflow';
const SERVICE_VERSION = '2.0.0';
const INSTRUMENTATION_SCOPE = 'aichatflow.llm-tracing';

/**
 * Check if endpoint is a real remote endpoint (not localhost in production).
 * Returns true if we should attempt actual HTTP exports.
 */
function isRealEndpoint(endpoint: string): boolean {
  const isProduction = process.env.NODE_ENV === 'production';
  const isLocalhost = endpoint.includes('localhost') || endpoint.includes('127.0.0.1');
  // In production, localhost is invalid (no local Jaeger)
  if (isProduction && isLocalhost) {
    return false;
  }
  // In development, localhost is valid
  // Any non-localhost endpoint is valid
  return true;
}

function getConfig() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || DEFAULT_ENDPOINT;
  const headersRaw = process.env.OTEL_EXPORTER_OTLP_HEADERS || '';
  const headers = parseHeaders(headersRaw);
  const batchSize = parseBatchSize(process.env.TRACE_EXPORT_BATCH_SIZE, DEFAULT_BATCH_SIZE);
  const flushIntervalMs = parseFlushIntervalMs(
    process.env.TRACE_EXPORT_FLUSH_INTERVAL,
    DEFAULT_FLUSH_INTERVAL_MS,
  );
  const dryRun = !isRealEndpoint(endpoint);

  return { endpoint, headers, batchSize, flushIntervalMs, dryRun };
}

// ============================================
// Helpers
// ============================================

function msToNanos(ms: number): string {
  // JS can't do 64-bit ints natively; use string concatenation
  const seconds = Math.floor(ms / 1000);
  const nanoRemainder = (ms % 1000) * 1_000_000;
  return `${seconds}${nanoRemainder.toString().padStart(9, '0')}`;
}

function toHex32(id: string): string {
  // Ensure traceId is 32 hex chars (OTel requires 128-bit trace IDs)
  if (id.length >= 32) return id.slice(0, 32);
  return id.padStart(32, '0');
}

function toHex16(id: string): string {
  // Ensure spanId is 16 hex chars (OTel requires 64-bit span IDs)
  if (id.length >= 16) return id.slice(0, 16);
  return id.padStart(16, '0');
}

function attr(
  key: string,
  value: string | number | boolean | null | undefined | string[],
): OtlpAttribute {
  if (value === null || value === undefined) {
    return { key, value: { stringValue: '' } };
  }
  if (Array.isArray(value)) {
    return {
      key,
      value: {
        arrayValue: {
          values: value.map((v) => ({ stringValue: v })),
        },
      },
    };
  }
  if (typeof value === 'string') return { key, value: { stringValue: value } };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { key, value: { intValue: value } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { boolValue: value } };
}

/**
 * Generate a random 16-character hex string for span IDs.
 */
function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================
// Convert LlmSpan → OTLP Span
// ============================================

function convertSpan(span: LlmSpan): OtlpSpan {
  const attributes: OtlpAttribute[] = [
    attr('llm.operation', span.operation),
    attr('llm.model', span.model),
    attr('llm.provider', span.provider),
    attr('llm.agent_name', span.agentName),
    attr('llm.demand_id', span.demandId),
    attr('llm.request_id', span.requestId),
  ];

  if (span.tokenUsage) {
    attributes.push(
      attr('llm.token_usage.prompt', span.tokenUsage.promptTokens),
      attr('llm.token_usage.completion', span.tokenUsage.completionTokens),
      attr('llm.token_usage.total', span.tokenUsage.totalTokens),
    );
  }

  if (span.estimatedCostUsd !== null) {
    attributes.push(attr('llm.cost_usd', span.estimatedCostUsd));
  }

  // Map status
  let statusCode = 0; // UNSET
  if (span.status === 'ok') statusCode = 1;
  else if (span.status === 'error') statusCode = 2;

  const otlpSpan: OtlpSpan = {
    traceId: toHex32(span.traceId),
    spanId: toHex16(span.spanId),
    name: `${span.operation} [${span.model}]`,
    kind: 1, // INTERNAL
    startTimeUnixNano: msToNanos(span.startedAt),
    endTimeUnixNano: msToNanos(span.endedAt ?? span.startedAt),
    attributes,
    status: {
      code: statusCode,
      message: span.error ?? undefined,
    },
  };

  if (span.parentSpanId) {
    otlpSpan.parentSpanId = toHex16(span.parentSpanId);
  }

  return otlpSpan;
}

// ============================================
// Service
// ============================================

export class TraceExporterService {
  private readonly buffer: LlmSpan[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly config = getConfig();

  private totalExported = 0;
  private totalFailed = 0;
  private totalBatches = 0;
  private totalDryRun = 0;
  private lastExportAt: number | null = null;

  constructor() {
    this.startFlushTimer();
    if (this.config.dryRun) {
      logger.info('Trace exporter running in DRY-RUN mode (no real OTLP endpoint configured)', {
        context: { endpoint: this.config.endpoint },
      });
    }
  }

  /**
   * Enqueue a completed span for export.
   * Non-blocking; the span is batched and flushed periodically.
   */
  enqueue(span: LlmSpan): void {
    this.buffer.push(span);

    if (this.buffer.length >= this.config.batchSize) {
      this.flush().catch(() => {
        /* non-fatal */
      });
    }
  }

  /**
   * Enqueue multiple spans.
   */
  enqueueMany(spans: LlmSpan[]): void {
    for (const span of spans) {
      this.enqueue(span);
    }
  }

  /**
   * Enqueue RAG pipeline spans for OTLP export.
   * Creates a parent span `rag.retrieve` with child spans for each substep.
   *
   * @param timings - The RAG substep timings
   * @param traceId - The trace ID to associate spans with
   * @param options - Provenance: cacheHit, requestId, chunkIds
   */
  enqueueRAGSpans(
    timings: RAGSubstepTimings,
    traceId: string,
    options: { cacheHit?: boolean; requestId?: string; chunkIds?: string[] } = {},
  ): void {
    const cacheHit = options.cacheHit ?? false;
    const chunkIds = options.chunkIds?.slice(0, 32) ?? [];
    try {
      const now = Date.now();
      const parentSpanId = generateSpanId();

      // Calculate start times for each substep based on durations
      // Substeps run sequentially: embedding -> vector_search -> metadata_filter -> rerank -> doc_fetch -> context_build
      let currentTime = now - timings.total_ms;

      const substeps: Array<{
        name: string;
        durationMs: number;
        startMs: number;
      }> = [{ name: 'rag.embedding', durationMs: timings.embedding_ms, startMs: currentTime }];
      currentTime += timings.embedding_ms;

      substeps.push({
        name: 'rag.vector_search',
        durationMs: timings.vector_search_ms,
        startMs: currentTime,
      });
      currentTime += timings.vector_search_ms;

      substeps.push({
        name: 'rag.metadata_filter',
        durationMs: timings.metadata_filter_ms,
        startMs: currentTime,
      });
      currentTime += timings.metadata_filter_ms;

      substeps.push({ name: 'rag.rerank', durationMs: timings.rerank_ms, startMs: currentTime });
      currentTime += timings.rerank_ms;

      substeps.push({
        name: 'rag.doc_fetch',
        durationMs: timings.doc_fetch_ms,
        startMs: currentTime,
      });
      currentTime += timings.doc_fetch_ms;

      substeps.push({
        name: 'rag.context_build',
        durationMs: timings.context_build_ms,
        startMs: currentTime,
      });

      // Build child spans
      const childSpans: OtlpSpan[] = substeps.map((substep) => ({
        traceId: toHex32(traceId),
        spanId: toHex16(generateSpanId()),
        parentSpanId: toHex16(parentSpanId),
        name: substep.name,
        kind: 1, // INTERNAL
        startTimeUnixNano: msToNanos(substep.startMs),
        endTimeUnixNano: msToNanos(substep.startMs + substep.durationMs),
        attributes: [
          attr('rag.substep.duration_ms', substep.durationMs),
          attr('rag.cache_hit', cacheHit),
        ],
        status: { code: 1 }, // OK
      }));

      // Build parent span
      const parentAttributes = [
        attr('rag.total_ms', timings.total_ms),
        attr('rag.embedding_ms', timings.embedding_ms),
        attr('rag.vector_search_ms', timings.vector_search_ms),
        attr('rag.metadata_filter_ms', timings.metadata_filter_ms),
        attr('rag.rerank_ms', timings.rerank_ms),
        attr('rag.doc_fetch_ms', timings.doc_fetch_ms),
        attr('rag.context_build_ms', timings.context_build_ms),
        attr('rag.cache_hit', cacheHit),
      ];
      // Provenance: correlate RAG span to the AI request and to the chunks
      // that grounded the response. requestId joins to the LLM span, audit
      // log, and ai_requests telemetry row; chunk_ids let a reviewer inspect
      // *what* was retrieved, not just *how long* it took.
      if (options.requestId) {
        parentAttributes.push(attr('request.id', options.requestId));
      }
      if (chunkIds.length > 0) {
        parentAttributes.push(attr('rag.chunk_ids', chunkIds));
        parentAttributes.push(attr('rag.chunk_count', chunkIds.length));
      }
      const parentSpan: OtlpSpan = {
        traceId: toHex32(traceId),
        spanId: toHex16(parentSpanId),
        name: 'rag.retrieve',
        kind: 1, // INTERNAL
        startTimeUnixNano: msToNanos(now - timings.total_ms),
        endTimeUnixNano: msToNanos(now),
        attributes: parentAttributes,
        status: { code: 1 }, // OK
      };

      // Build payload directly (bypass LlmSpan conversion)
      const payload: OtlpExportPayload = {
        resourceSpans: [
          {
            resource: {
              attributes: [
                attr('service.name', SERVICE_NAME),
                attr('service.version', SERVICE_VERSION),
                attr('deployment.environment', process.env.NODE_ENV || 'development'),
              ],
            },
            scopeSpans: [
              {
                scope: {
                  name: 'aichatflow.rag-pipeline',
                  version: SERVICE_VERSION,
                },
                spans: [parentSpan, ...childSpans],
              },
            ],
          },
        ],
      };

      // Export asynchronously (non-blocking)
      this.exportRAGPayload(payload).catch((error) => {
        logger.warn('RAG span export failed', {
          context: { error: error instanceof Error ? error.message : String(error) },
        });
      });
    } catch (error) {
      // OTLP failures should never break the pipeline
      logger.warn('Failed to create RAG spans', {
        context: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  /**
   * Export RAG payload directly to OTLP endpoint.
   * Private helper for enqueueRAGSpans.
   */
  private async exportRAGPayload(payload: OtlpExportPayload): Promise<void> {
    if (this.config.dryRun) {
      this.totalDryRun += payload.resourceSpans[0]?.scopeSpans[0]?.spans.length || 0;
      this.totalExported += payload.resourceSpans[0]?.scopeSpans[0]?.spans.length || 0;
      this.lastExportAt = Date.now();
      logger.debug('RAG span export (dry-run)', {
        context: { spanCount: payload.resourceSpans[0]?.scopeSpans[0]?.spans.length },
      });
      return;
    }

    const url = `${this.config.endpoint}/v1/traces`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.config.headers,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`OTLP export failed: ${response.status} ${response.statusText}`);
    }

    const spanCount = payload.resourceSpans[0]?.scopeSpans[0]?.spans.length || 0;
    this.totalExported += spanCount;
    this.lastExportAt = Date.now();

    logger.debug('RAG span export sent', {
      context: { spanCount, endpoint: url },
    });
  }

  /**
   * Flush buffered spans to the OTLP endpoint.
   * In dry-run mode, spans are counted but not sent over HTTP.
   */
  async flush(): Promise<number> {
    if (this.buffer.length === 0) return 0;

    const batch = this.buffer.splice(0, this.config.batchSize);

    // DRY-RUN mode: count spans without HTTP export
    if (this.config.dryRun) {
      this.totalDryRun += batch.length;
      this.totalExported += batch.length; // Count as "exported" for metrics
      this.totalBatches++;
      this.lastExportAt = Date.now();

      logger.debug('Trace export batch (dry-run)', {
        context: {
          spanCount: batch.length,
          dryRun: true,
        },
      });

      return batch.length;
    }

    const payload = this.buildPayload(batch);

    try {
      const url = `${this.config.endpoint}/v1/traces`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.config.headers,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new Error(`OTLP export failed: ${response.status} ${response.statusText}`);
      }

      this.totalExported += batch.length;
      this.totalBatches++;
      this.lastExportAt = Date.now();

      logger.debug('Trace export batch sent', {
        context: {
          spanCount: batch.length,
          endpoint: url,
        },
      });

      return batch.length;
    } catch (error) {
      this.totalFailed += batch.length;
      logger.warn('Trace export failed, spans dropped', {
        context: {
          spanCount: batch.length,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return 0;
    }
  }

  /**
   * Build OTLP export payload from spans.
   */
  private buildPayload(spans: LlmSpan[]): OtlpExportPayload {
    return {
      resourceSpans: [
        {
          resource: {
            attributes: [
              attr('service.name', SERVICE_NAME),
              attr('service.version', SERVICE_VERSION),
              attr('deployment.environment', process.env.NODE_ENV || 'development'),
            ],
          },
          scopeSpans: [
            {
              scope: {
                name: INSTRUMENTATION_SCOPE,
                version: SERVICE_VERSION,
              },
              spans: spans.map(convertSpan),
            },
          ],
        },
      ],
    };
  }

  /**
   * Get exporter statistics.
   */
  getStats(): {
    bufferSize: number;
    totalExported: number;
    totalFailed: number;
    totalBatches: number;
    totalDryRun: number;
    lastExportAt: number | null;
    endpoint: string;
    batchSize: number;
    flushIntervalMs: number;
    dryRun: boolean;
  } {
    return {
      bufferSize: this.buffer.length,
      totalExported: this.totalExported,
      totalFailed: this.totalFailed,
      totalBatches: this.totalBatches,
      totalDryRun: this.totalDryRun,
      lastExportAt: this.lastExportAt,
      endpoint: this.config.endpoint,
      batchSize: this.config.batchSize,
      flushIntervalMs: this.config.flushIntervalMs,
      dryRun: this.config.dryRun,
    };
  }

  /**
   * Clear buffer and stats (for tests).
   */
  clear(): void {
    this.buffer.length = 0;
    this.totalExported = 0;
    this.totalFailed = 0;
    this.totalBatches = 0;
    this.totalDryRun = 0;
    this.lastExportAt = null;
  }

  /**
   * Send a test span to verify OTLP export is working.
   * Returns diagnostics about the export attempt.
   */
  async sendTestSpan(): Promise<{
    success: boolean;
    dryRun: boolean;
    endpoint: string;
    error?: string;
    responseStatus?: number;
  }> {
    const testSpan: LlmSpan = {
      traceId: 'test-' + Date.now().toString(16).padStart(32, '0'),
      spanId: Date.now().toString(16).padStart(16, '0'),
      parentSpanId: null,
      operation: 'test_export',
      model: 'test-model',
      provider: 'test',
      agentName: 'test-agent',
      demandId: null,
      requestId: 'test-request',
      status: 'ok',
      startedAt: Date.now() - 100,
      endedAt: Date.now(),
      durationMs: 100,
      input: null,
      output: null,
      error: null,
      tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      estimatedCostUsd: 0.001,
      attributes: {},
    };

    if (this.config.dryRun) {
      this.totalDryRun += 1;
      this.totalExported += 1;
      this.totalBatches++;
      this.lastExportAt = Date.now();
      return {
        success: true,
        dryRun: true,
        endpoint: this.config.endpoint,
      };
    }

    const payload = this.buildPayload([testSpan]);
    const url = `${this.config.endpoint}/v1/traces`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.config.headers,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        return {
          success: false,
          dryRun: false,
          endpoint: url,
          error: `HTTP ${response.status}: ${response.statusText}`,
          responseStatus: response.status,
        };
      }

      this.totalExported += 1;
      this.totalBatches++;
      this.lastExportAt = Date.now();

      return {
        success: true,
        dryRun: false,
        endpoint: url,
        responseStatus: response.status,
      };
    } catch (error) {
      return {
        success: false,
        dryRun: false,
        endpoint: url,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Stop the flush timer (for tests/shutdown).
   */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {
        /* non-fatal */
      });
    }, this.config.flushIntervalMs);
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }
}

export const traceExporterService = new TraceExporterService();
