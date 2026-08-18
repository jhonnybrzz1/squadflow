/**
 * LLM Tracing Operations
 *
 * Gerencia operações de tracing para LLM calls:
 * - Inicialização de spans
 * - Finalização de spans
 * - Feature flag checking
 */

import { llmTracingService, type LlmSpan } from './llm-tracing';
import { llmMetricsCollector } from './llm-metrics-collector';
import { featureFlags } from './feature-flags';
import type { AIProvider } from './llm-client-manager';

export interface TracingOptions {
  operation: string;
  model: string;
  provider: AIProvider;
  agentName?: string;
  demandId?: number;
  requestId: string;
  input?: {
    messageCount: number;
    lastUserMessage?: string;
  };
}

export interface TracingContext {
  span: LlmSpan | null;
  enabled: boolean;
}

/**
 * Inicializa tracing span se feature flag estiver habilitada
 */
export function startTracing(options: TracingOptions): TracingContext {
  let enabled = false;
  try {
    const flags = featureFlags.getFlags();
    enabled = flags.enableLlmTracing === true;
  } catch (_) {
    /* ignore */
  }

  const span: LlmSpan | null = enabled
    ? llmTracingService.startSpan({
        operation: options.operation,
        model: options.model,
        provider: options.provider,
        agentName: options.agentName,
        demandId: options.demandId,
        requestId: options.requestId,
        input: options.input,
      })
    : null;

  return { span, enabled };
}

/**
 * Finaliza tracing span com resultado
 */
export function endTracing(
  context: TracingContext,
  result: {
    content: string;
    modelUsed: string;
    provider: AIProvider;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    latencyMs: number;
    error?: string;
  },
): void {
  if (!context.enabled || !context.span) {
    return;
  }

  llmTracingService.endSpan(context.span.spanId, {
    status: result.error ? 'error' : 'ok',
    output: {
      contentLength: result.content.length,
      messageCount: 1,
      latencyMs: result.latencyMs,
    },
    tokenUsage: {
      promptTokens: result.usage?.promptTokens || 0,
      completionTokens: result.usage?.completionTokens || 0,
      totalTokens: result.usage?.totalTokens || 0,
    },
    error: result.error,
  });

  llmMetricsCollector.record({
    provider: context.span.provider,
    model: context.span.model,
    latencyMs: result.latencyMs,
    errorFlag: !!result.error,
    cacheHit: false,
    costEstimate: null,
    operationType: context.span.operation,
    demandId: context.span.demandId,
    requestId: context.span.requestId,
    agentName: context.span.agentName,
    metadata: {
      promptTokens: result.usage?.promptTokens,
      completionTokens: result.usage?.completionTokens,
      totalTokens: result.usage?.totalTokens,
      tracing: true,
    },
  });
}
