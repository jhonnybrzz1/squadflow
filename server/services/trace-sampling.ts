/**
 * Configurable Sampling Service
 *
 * Controls which LLM spans/traces are recorded and exported to reduce
 * overhead in production. Supports multiple sampling strategies:
 *
 * 1. Rate-based: Sample N% of all requests (e.g., 10% in prod)
 * 2. Always-on for errors: Error spans are always sampled
 * 3. Head-based decision: Decision made at trace start, propagated to children
 * 4. Priority override: Specific operations/agents can force sampling
 *
 * Env vars:
 * - TRACE_SAMPLE_RATE       (0.0 - 1.0, default: 1.0 = 100%)
 * - TRACE_ALWAYS_SAMPLE_ERRORS  (default: true)
 * - TRACE_PRIORITY_OPERATIONS   (comma-separated, e.g. "agent_flow,analysis")
 * - TRACE_PRIORITY_AGENTS       (comma-separated, e.g. "product_owner")
 */

import { logger } from '../utils/logger';

// ============================================
// Types
// ============================================

export interface SamplingDecision {
  sampled: boolean;
  reason: 'rate' | 'error' | 'priority_operation' | 'priority_agent' | 'parent' | 'disabled';
}

export interface SamplingConfig {
  /** Sample rate 0.0-1.0 (default: 1.0) */
  sampleRate: number;
  /** Always sample error spans (default: true) */
  alwaysSampleErrors: boolean;
  /** Operations that always get sampled */
  priorityOperations: Set<string>;
  /** Agents that always get sampled */
  priorityAgents: Set<string>;
  /** Enable/disable sampling entirely (default: true) */
  enabled: boolean;
}

export interface SamplingStats {
  totalDecisions: number;
  sampledCount: number;
  droppedCount: number;
  errorSampledCount: number;
  prioritySampledCount: number;
  effectiveSampleRate: number;
  configuredSampleRate: number;
}

// ============================================
// Configuration
// ============================================

function loadConfig(): SamplingConfig {
  const sampleRate = parseFloat(process.env.TRACE_SAMPLE_RATE || '1.0');
  const alwaysSampleErrors = process.env.TRACE_ALWAYS_SAMPLE_ERRORS !== 'false';
  const priorityOps = (process.env.TRACE_PRIORITY_OPERATIONS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const priorityAgents = (process.env.TRACE_PRIORITY_AGENTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    sampleRate: Math.max(0, Math.min(1, isNaN(sampleRate) ? 1.0 : sampleRate)),
    alwaysSampleErrors,
    priorityOperations: new Set(priorityOps),
    priorityAgents: new Set(priorityAgents),
    enabled: true,
  };
}

// ============================================
// Service
// ============================================

export class TraceSamplingService {
  private config: SamplingConfig;
  // Head-based sampling decisions: traceId → sampled
  private readonly traceDecisions: Map<string, boolean> = new Map();
  private readonly maxDecisionCache = 5000;

  private totalDecisions = 0;
  private sampledCount = 0;
  private droppedCount = 0;
  private errorSampledCount = 0;
  private prioritySampledCount = 0;

  constructor(config?: Partial<SamplingConfig>) {
    const envConfig = loadConfig();
    this.config = { ...envConfig, ...config };
  }

  /**
   * Decide whether a new span should be sampled.
   *
   * @param traceId - The trace ID (for head-based propagation)
   * @param operation - The operation name
   * @param agentName - Optional agent name
   * @param isError - Whether this is an error span
   * @param parentTraceId - If set, inherit parent's sampling decision
   */
  shouldSample(options: {
    traceId: string;
    operation: string;
    agentName?: string;
    isError?: boolean;
    parentTraceId?: string;
  }): SamplingDecision {
    this.totalDecisions++;

    if (!this.config.enabled) {
      this.droppedCount++;
      return { sampled: false, reason: 'disabled' };
    }

    // 1. Check parent decision (head-based propagation)
    if (options.parentTraceId) {
      const parentDecision = this.traceDecisions.get(options.parentTraceId);
      if (parentDecision !== undefined) {
        if (parentDecision) this.sampledCount++;
        else this.droppedCount++;
        return { sampled: parentDecision, reason: 'parent' };
      }
    }

    // 2. Check existing trace decision (same trace, different span)
    const existingDecision = this.traceDecisions.get(options.traceId);
    if (existingDecision !== undefined) {
      if (existingDecision) this.sampledCount++;
      else this.droppedCount++;
      return { sampled: existingDecision, reason: 'parent' };
    }

    // 3. Always sample errors
    if (options.isError && this.config.alwaysSampleErrors) {
      this.sampledCount++;
      this.errorSampledCount++;
      this.recordDecision(options.traceId, true);
      return { sampled: true, reason: 'error' };
    }

    // 4. Priority operations
    if (this.config.priorityOperations.has(options.operation)) {
      this.sampledCount++;
      this.prioritySampledCount++;
      this.recordDecision(options.traceId, true);
      return { sampled: true, reason: 'priority_operation' };
    }

    // 5. Priority agents
    if (options.agentName && this.config.priorityAgents.has(options.agentName)) {
      this.sampledCount++;
      this.prioritySampledCount++;
      this.recordDecision(options.traceId, true);
      return { sampled: true, reason: 'priority_agent' };
    }

    // 6. Rate-based sampling
    const sampled = Math.random() < this.config.sampleRate;
    if (sampled) {
      this.sampledCount++;
    } else {
      this.droppedCount++;
    }
    this.recordDecision(options.traceId, sampled);
    return { sampled, reason: 'rate' };
  }

  /**
   * Update configuration at runtime (e.g., from feature flags).
   */
  updateConfig(updates: Partial<SamplingConfig>): void {
    this.config = { ...this.config, ...updates };
    if (updates.sampleRate !== undefined) {
      this.config.sampleRate = Math.max(0, Math.min(1, updates.sampleRate));
    }
    logger.info('Trace sampling config updated', {
      context: {
        sampleRate: this.config.sampleRate,
        alwaysSampleErrors: this.config.alwaysSampleErrors,
      },
    });
  }

  /**
   * Get current configuration.
   */
  getConfig(): Readonly<SamplingConfig> {
    return { ...this.config };
  }

  /**
   * Get sampling statistics.
   */
  getStats(): SamplingStats {
    return {
      totalDecisions: this.totalDecisions,
      sampledCount: this.sampledCount,
      droppedCount: this.droppedCount,
      errorSampledCount: this.errorSampledCount,
      prioritySampledCount: this.prioritySampledCount,
      effectiveSampleRate: this.totalDecisions > 0 ? this.sampledCount / this.totalDecisions : 0,
      configuredSampleRate: this.config.sampleRate,
    };
  }

  /**
   * Clear all state (for tests).
   */
  clear(): void {
    this.traceDecisions.clear();
    this.totalDecisions = 0;
    this.sampledCount = 0;
    this.droppedCount = 0;
    this.errorSampledCount = 0;
    this.prioritySampledCount = 0;
  }

  // ============================================
  // Private
  // ============================================

  private recordDecision(traceId: string, sampled: boolean): void {
    this.traceDecisions.set(traceId, sampled);

    // Evict oldest entries when cache is full
    if (this.traceDecisions.size > this.maxDecisionCache) {
      const firstKey = this.traceDecisions.keys().next().value;
      if (firstKey) this.traceDecisions.delete(firstKey);
    }
  }
}

export const traceSamplingService = new TraceSamplingService();
