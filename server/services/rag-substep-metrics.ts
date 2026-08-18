/**
 * RAG Substep Metrics Service
 *
 * Tracks timing for individual RAG pipeline substeps to enable
 * performance diagnosis and latency attribution.
 *
 * Substeps tracked (7 metrics per PRD):
 * - embedding_ms: Time to embed the query
 * - vector_search_ms: Time to search the vector store
 * - metadata_filter_ms: Time to apply metadata filters
 * - rerank_ms: Time for Cohere/LLM reranking
 * - doc_fetch_ms: Time to fetch document metadata
 * - context_build_ms: Time to build final context string
 * - total_ms: Total RAG pipeline time
 */

import { logger } from '../utils/logger';
import { traceExporterService } from './trace-exporter';

export interface RAGSubstepTimings {
  embedding_ms: number;
  vector_search_ms: number;
  metadata_filter_ms: number;
  rerank_ms: number;
  doc_fetch_ms: number;
  context_build_ms: number;
  total_ms: number;
}

/** Options passed to finish() */
export interface RAGTimerFinishOptions {
  cacheHit?: boolean;
  traceId?: string;
  /**
   * Correlated request ID from the AI call layer. Enables joining a RAG
   * span to the parent LLM span, audit log, and ai_requests telemetry row.
   */
  requestId?: string;
  /**
   * IDs of the chunks that grounded the response. Captured as a span
   * attribute so a trace can be inspected to see *what* was retrieved,
   * not just *how long* it took. Truncated to the first 32 entries to
   * keep span size bounded.
   */
  chunkIds?: string[];
}

export interface RAGSubstepStats {
  totalCalls: number;
  avgTotalMs: number;
  avgEmbeddingMs: number;
  avgVectorSearchMs: number;
  avgMetadataFilterMs: number;
  avgRerankMs: number;
  avgDocFetchMs: number;
  avgContextBuildMs: number;
  p95TotalMs: number;
  p99TotalMs: number;
  lastTimings: RAGSubstepTimings | null;
  recentTimings: RAGSubstepTimings[];
  slowestSubstep: string | null;
}

// ANSI color codes for terminal output
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
};

const MAX_HISTORY = 100;

class RAGSubstepMetricsService {
  private history: RAGSubstepTimings[] = [];
  private totalCalls = 0;

  /**
   * Check if we should sample this request based on RAG_INSTRUMENTATION_SAMPLE_RATE.
   * Returns true if we should record/export this request.
   */
  private shouldSample(): boolean {
    const rateStr = process.env.RAG_INSTRUMENTATION_SAMPLE_RATE;
    if (!rateStr) return true; // Default: sample all
    const rate = parseFloat(rateStr);
    if (isNaN(rate) || rate >= 1.0) return true;
    if (rate <= 0) return false;
    return Math.random() < rate;
  }

  /**
   * Format the BOTTLENECK summary line with ANSI colors.
   * - If one step >40%: highlight it as THE bottleneck
   * - Otherwise: show top 2 contributors
   * - Cache hit: show "N/A (cache hit)"
   */
  formatBottleneckSummary(timings: RAGSubstepTimings, cacheHit: boolean = false): string {
    if (cacheHit) {
      return `${ANSI.green}${ANSI.bold}>>> BOTTLENECK: N/A (cache hit)${ANSI.reset}`;
    }

    const total = timings.total_ms;
    if (total <= 0) {
      return `${ANSI.green}>>> BOTTLENECK: N/A (zero latency)${ANSI.reset}`;
    }

    const substeps = [
      { name: 'embedding', ms: timings.embedding_ms },
      { name: 'vector_search', ms: timings.vector_search_ms },
      { name: 'metadata_filter', ms: timings.metadata_filter_ms },
      { name: 'rerank', ms: timings.rerank_ms },
      { name: 'doc_fetch', ms: timings.doc_fetch_ms },
      { name: 'context_build', ms: timings.context_build_ms },
    ];

    // Calculate percentages and sort descending
    const withPct = substeps
      .map((s) => ({
        ...s,
        pct: Math.round((s.ms / total) * 100),
      }))
      .filter((s) => s.pct > 0)
      .sort((a, b) => b.pct - a.pct);

    if (withPct.length === 0) {
      return `${ANSI.green}>>> BOTTLENECK: N/A (no measurable substeps)${ANSI.reset}`;
    }

    const top = withPct[0];

    // Color based on severity
    const getColor = (pct: number): string => {
      if (pct >= 60) return `${ANSI.red}${ANSI.bold}`;
      if (pct >= 40) return ANSI.yellow;
      return ANSI.green;
    };

    // If top contributor >40%, highlight as THE bottleneck
    if (top.pct >= 40) {
      const color = getColor(top.pct);
      return `${color}>>> BOTTLENECK: ${top.name} (${top.pct}%)${ANSI.reset}`;
    }

    // Otherwise, show top 2
    const top2 = withPct.slice(0, 2);
    const parts = top2.map((s) => `${s.name} (${s.pct}%)`).join(', ');
    return `${ANSI.cyan}>>> BOTTLENECK: ${parts}${ANSI.reset}`;
  }

  /**
   * Record a new set of substep timings.
   * Respects sampling rate for logging/export.
   */
  record(timings: RAGSubstepTimings, options: RAGTimerFinishOptions = {}): void {
    // Always increment counter
    this.totalCalls++;

    // Check sampling for detailed recording
    if (!this.shouldSample()) {
      return;
    }

    this.history.push(timings);

    // Trim history to max size
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }

    // Log structured metrics (7 metrics as per PRD)
    logger.info('RAG metrics', {
      context: {
        'rag.embedding_ms': timings.embedding_ms,
        'rag.vector_search_ms': timings.vector_search_ms,
        'rag.metadata_filter_ms': timings.metadata_filter_ms,
        'rag.rerank_ms': timings.rerank_ms,
        'rag.doc_fetch_ms': timings.doc_fetch_ms,
        'rag.context_build_ms': timings.context_build_ms,
        'rag.total_ms': timings.total_ms,
      },
    });

    // Log bottleneck summary with ANSI colors
    const bottleneckSummary = this.formatBottleneckSummary(timings, options.cacheHit);
    // Use console.log for ANSI colors (logger strips them)
    logger.info(bottleneckSummary);

    // Export to OTLP if trace ID provided
    if (options.traceId) {
      try {
        traceExporterService.enqueueRAGSpans(timings, options.traceId, {
          cacheHit: options.cacheHit,
          requestId: options.requestId,
          chunkIds: options.chunkIds,
        });
      } catch (error) {
        // OTLP failures should never break the pipeline
        logger.warn('Failed to enqueue RAG spans for OTLP export', {
          context: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    }

    // Warn if total exceeds threshold (200ms)
    if (timings.total_ms > 200) {
      logger.warn('RAG latency exceeded threshold', {
        context: {
          total_ms: timings.total_ms,
          embedding_ms: timings.embedding_ms,
          vector_search_ms: timings.vector_search_ms,
          metadata_filter_ms: timings.metadata_filter_ms,
          rerank_ms: timings.rerank_ms,
          doc_fetch_ms: timings.doc_fetch_ms,
          context_build_ms: timings.context_build_ms,
          slowest: this.findSlowestSubstep(timings),
        },
      });
    }
  }

  /**
   * Create a timer helper for tracking substeps.
   */
  createTimer(): RAGTimer {
    return new RAGTimer(this);
  }

  /**
   * Get aggregated statistics.
   */
  getStats(): RAGSubstepStats {
    if (this.history.length === 0) {
      return {
        totalCalls: this.totalCalls,
        avgTotalMs: 0,
        avgEmbeddingMs: 0,
        avgVectorSearchMs: 0,
        avgMetadataFilterMs: 0,
        avgRerankMs: 0,
        avgDocFetchMs: 0,
        avgContextBuildMs: 0,
        p95TotalMs: 0,
        p99TotalMs: 0,
        lastTimings: null,
        recentTimings: [],
        slowestSubstep: null,
      };
    }

    const n = this.history.length;
    const sum = (fn: (t: RAGSubstepTimings) => number) =>
      this.history.reduce((acc, t) => acc + fn(t), 0);

    const avgTotalMs = sum((t) => t.total_ms) / n;
    const avgEmbeddingMs = sum((t) => t.embedding_ms) / n;
    const avgVectorSearchMs = sum((t) => t.vector_search_ms) / n;
    const avgMetadataFilterMs = sum((t) => t.metadata_filter_ms) / n;
    const avgRerankMs = sum((t) => t.rerank_ms) / n;
    const avgDocFetchMs = sum((t) => t.doc_fetch_ms) / n;
    const avgContextBuildMs = sum((t) => t.context_build_ms) / n;

    // Calculate percentiles
    const sortedTotals = [...this.history].map((t) => t.total_ms).sort((a, b) => a - b);
    const p95Index = Math.floor(n * 0.95);
    const p99Index = Math.floor(n * 0.99);
    const p95TotalMs = sortedTotals[Math.min(p95Index, n - 1)];
    const p99TotalMs = sortedTotals[Math.min(p99Index, n - 1)];

    // Find slowest substep on average
    const substepAvgs = [
      { name: 'embedding', avg: avgEmbeddingMs },
      { name: 'vector_search', avg: avgVectorSearchMs },
      { name: 'metadata_filter', avg: avgMetadataFilterMs },
      { name: 'rerank', avg: avgRerankMs },
      { name: 'doc_fetch', avg: avgDocFetchMs },
      { name: 'context_build', avg: avgContextBuildMs },
    ];
    const slowest = substepAvgs.reduce((max, curr) => (curr.avg > max.avg ? curr : max));

    return {
      totalCalls: this.totalCalls,
      avgTotalMs: Math.round(avgTotalMs),
      avgEmbeddingMs: Math.round(avgEmbeddingMs),
      avgVectorSearchMs: Math.round(avgVectorSearchMs),
      avgMetadataFilterMs: Math.round(avgMetadataFilterMs),
      avgRerankMs: Math.round(avgRerankMs),
      avgDocFetchMs: Math.round(avgDocFetchMs),
      avgContextBuildMs: Math.round(avgContextBuildMs),
      p95TotalMs: Math.round(p95TotalMs),
      p99TotalMs: Math.round(p99TotalMs),
      lastTimings: this.history[this.history.length - 1] || null,
      recentTimings: this.history.slice(-10),
      slowestSubstep: slowest.avg > 0 ? slowest.name : null,
    };
  }

  /**
   * Clear all history (for tests).
   */
  clear(): void {
    this.history = [];
    this.totalCalls = 0;
  }

  private findSlowestSubstep(timings: RAGSubstepTimings): string {
    const substeps = [
      { name: 'embedding', ms: timings.embedding_ms },
      { name: 'vector_search', ms: timings.vector_search_ms },
      { name: 'metadata_filter', ms: timings.metadata_filter_ms },
      { name: 'rerank', ms: timings.rerank_ms },
      { name: 'doc_fetch', ms: timings.doc_fetch_ms },
      { name: 'context_build', ms: timings.context_build_ms },
    ];
    return substeps.reduce((max, curr) => (curr.ms > max.ms ? curr : max)).name;
  }
}

/**
 * Timer helper for tracking RAG substeps.
 */
export class RAGTimer {
  private startTime: number;
  private timings: Partial<RAGSubstepTimings> = {};
  private currentSubstep: string | null = null;
  private substepStart: number | null = null;

  constructor(private service: RAGSubstepMetricsService) {
    this.startTime = performance.now();
  }

  /**
   * Start timing a substep.
   */
  startSubstep(name: keyof Omit<RAGSubstepTimings, 'total_ms'>): void {
    if (this.currentSubstep && this.substepStart !== null) {
      // Auto-end previous substep
      this.endSubstep();
    }
    this.currentSubstep = name;
    this.substepStart = performance.now();
  }

  /**
   * End the current substep and record its timing.
   */
  endSubstep(): void {
    if (this.currentSubstep && this.substepStart !== null) {
      const elapsed = performance.now() - this.substepStart;
      (this.timings as Record<string, number>)[this.currentSubstep] = Math.round(elapsed);
      this.currentSubstep = null;
      this.substepStart = null;
    }
  }

  /**
   * Finalize and record all timings.
   * @param options - Optional settings including cacheHit flag and traceId
   */
  finish(options: RAGTimerFinishOptions = {}): RAGSubstepTimings {
    // End any pending substep
    this.endSubstep();

    const totalMs = Math.round(performance.now() - this.startTime);

    const finalTimings: RAGSubstepTimings = {
      embedding_ms: this.timings.embedding_ms ?? 0,
      vector_search_ms: this.timings.vector_search_ms ?? 0,
      metadata_filter_ms: this.timings.metadata_filter_ms ?? 0,
      rerank_ms: this.timings.rerank_ms ?? 0,
      doc_fetch_ms: this.timings.doc_fetch_ms ?? 0,
      context_build_ms: this.timings.context_build_ms ?? 0,
      total_ms: totalMs,
    };

    this.service.record(finalTimings, options);
    return finalTimings;
  }
}

export const ragSubstepMetrics = new RAGSubstepMetricsService();
