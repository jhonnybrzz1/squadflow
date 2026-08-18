/**
 * Shared tool-call telemetry helper.
 *
 * Records tool usage into the AI usage tracker for cost attribution. The
 * tracker's `model` label is configurable via the optional `model` parameter.
 */
import { aiUsageTracker } from './ai-usage-tracker';
import { logger } from '../utils/logger';

export interface ToolUsageInput {
  /** Tool name, stored as "tool:<name>" in the tracker. */
  name: string;
  /** Demand that triggered this tool call, for cost attribution. */
  demandId?: number;
  /** Wall-clock time for the tool execution. */
  latencyMs: number;
  /** Whether the tool returned ok:true. */
  ok: boolean;
  /**
   * Label for the tracker's model field.
   * Use 'internal-tool' for generic agent tools so dashboards can distinguish them.
   * @default 'internal-tool'
   */
  model?: string;
}

export function recordToolUsage(input: ToolUsageInput): void {
  try {
    aiUsageTracker.record({
      timestamp: new Date().toISOString(),
      demandId: input.demandId,
      operation: `tool:${input.name}`,
      model: input.model ?? 'internal-tool',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: null,
      cacheHit: false,
      estimatedTokensSaved: 0,
      estimatedCostSavedUsd: null,
      latencyMs: input.latencyMs,
      routingMode: 'unknown',
      routingReason: input.ok ? 'tool_execution_ok' : 'tool_execution_error',
      fallbackUsed: false,
    });
  } catch (err) {
    logger.warn('Falha ao registrar telemetria de tool', {
      error: err instanceof Error ? err : undefined,
      context: { toolName: input.name, demandId: input.demandId },
    });
  }
}
