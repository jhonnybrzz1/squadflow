/**
 * LLM Cache Operations
 *
 * Gerencia operações de cache para LLM responses:
 * - Response cache (exato)
 * - Semantic cache (similaridade de embeddings)
 */

import { aiResponseCache } from './ai-cache';
import { estimateTextTokens, estimateCost } from './ai-usage-tracker';
import { aiUsageTracker } from './ai-usage-tracker';
import { llmMetricsCollector } from './llm-metrics-collector';
import { computeContextFingerprint, semanticCacheService } from './semantic-cache';
import { featureFlags } from './feature-flags';
import { logger } from '../utils/logger';
import type { RoutingMode } from './ai-usage-tracker';

export interface CacheLookupOptions {
  model: string;
  provider: string;
  messages: Array<Record<string, unknown>>;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: string;
  operation: string;
  cacheContext?: unknown;
  demandId?: number;
  requestId: string;
  routingMode: RoutingMode;
  routingReason: string | null;
  cacheKeyVersion: string;
  originalModel: string;
  startedAt: number;
  /** Spec 10259 T5: hash SHA-256 do conteúdo bruto do system prompt externo. */
  promptHash?: string | null;
  /** M-2: identificador do agente. */
  agentId?: string;
  /** M-2: etapa do pipeline. */
  stage?: string;
}

export interface CacheHitResult {
  content: string;
  metadata: {
    modelUsed: string;
    provider: string;
    originalModel: string;
    fallbackUsed: boolean;
    fallbackReason: string | null;
    routingMode: RoutingMode;
    routingReason: string | null;
    cacheHit: true;
    semanticCacheHit?: boolean;
    semanticSimilarity?: number;
    promptTokens?: number;
    completionTokens?: number;
    costEstimate?: number;
  };
}

/**
 * Tenta recuperar resposta do response cache (exato)
 */
export async function tryResponseCache(
  cacheKey: string,
  preparedMessages: unknown[],
  options: CacheLookupOptions,
): Promise<CacheHitResult | null> {
  const cached = await aiResponseCache.getAsync(cacheKey);
  if (cached !== null) {
    const promptTokensSaved = estimateTextTokens(JSON.stringify(preparedMessages));
    const completionTokensSaved = estimateTextTokens(cached);
    const costEstimate = await estimateCost(
      options.model,
      promptTokensSaved,
      completionTokensSaved,
    );
    const estimatedCostSavedUsd = costEstimate.listCostUsd;

    aiUsageTracker.record({
      timestamp: new Date().toISOString(),
      demandId: options.demandId,
      operation: options.operation,
      model: `${options.provider}:${options.model}`,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      cacheHit: true,
      estimatedTokensSaved: promptTokensSaved + completionTokensSaved,
      estimatedCostSavedUsd,
      latencyMs: Date.now() - options.startedAt,
      requestId: options.requestId,
      routingMode: options.routingMode,
      routingReason: options.routingReason,
      cacheKeyVersion: options.cacheKeyVersion,
      fallbackUsed: false,
      agentId: options.agentId,
      stage: options.stage,
    });

    llmMetricsCollector.record({
      provider: options.provider,
      model: options.model,
      latencyMs: Date.now() - options.startedAt,
      errorFlag: false,
      cacheHit: true,
      costEstimate: 0,
      operationType: options.operation,
      demandId: options.demandId,
      requestId: options.requestId,
      metadata: { cacheType: 'exact', cacheKeyVersion: options.cacheKeyVersion },
    });

    return {
      content: cached,
      metadata: {
        modelUsed: options.model,
        provider: options.provider,
        originalModel: options.originalModel,
        fallbackUsed: false,
        fallbackReason: null,
        routingMode: options.routingMode,
        routingReason: options.routingReason,
        cacheHit: true,
        promptTokens: 0,
        completionTokens: 0,
        costEstimate: 0,
      },
    };
  }

  return null;
}

/**
 * Tenta recuperar resposta do semantic cache (similaridade)
 */
export async function trySemanticCache(
  preparedMessages: unknown[],
  options: CacheLookupOptions,
): Promise<CacheHitResult | null> {
  let semanticCacheEnabled = false;
  try {
    const flags = featureFlags.getFlags();
    semanticCacheEnabled = flags.enableSemanticCache === true;
  } catch (_) {
    /* ignore */
  }

  if (!semanticCacheEnabled) {
    return null;
  }

  if (options.responseFormat !== 'text') {
    return null;
  }

  const userMessage = (preparedMessages as Array<{ role: string; content: string }>)
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join(' ')
    .trim();

  if (userMessage.length <= 10) {
    return null;
  }

  // Spec 015 (H-04): o hit exige fingerprint contextual idêntico; sem
  // fingerprint computável, o cache semântico fica desativado (FR-003).
  // Spec 10259 T5: se um prompt externo versionado está disponível, usa
  // seu hash (SHA-256 do bruto) em vez do conteúdo renderizado do system
  // message — assim a mudança no arquivo invalida o cache.
  const contextFingerprint = computeContextFingerprint({
    systemMessages: options.messages.filter((m) => m.role === 'system'),
    cacheContext: options.cacheContext ?? null,
    temperature: options.temperature ?? null,
    maxTokens: options.maxTokens ?? null,
    responseFormat: options.responseFormat ?? 'text',
    promptHash: options.promptHash,
  });
  if (!contextFingerprint) {
    return null;
  }

  try {
    const semanticHit = await semanticCacheService.get(
      userMessage,
      `${options.provider}:${options.model}`,
      options.operation,
      contextFingerprint,
    );
    if (semanticHit) {
      const promptTokensSaved = estimateTextTokens(JSON.stringify(preparedMessages));
      const completionTokensSaved = estimateTextTokens(semanticHit.response);
      const costEstimate = await estimateCost(
        options.model,
        promptTokensSaved,
        completionTokensSaved,
      );
      const estimatedCostSavedUsd = costEstimate.listCostUsd;

      aiUsageTracker.record({
        timestamp: new Date().toISOString(),
        demandId: options.demandId,
        operation: options.operation,
        model: `${options.provider}:${options.model}`,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        cacheHit: true,
        estimatedTokensSaved: promptTokensSaved + completionTokensSaved,
        estimatedCostSavedUsd,
        latencyMs: Date.now() - options.startedAt,
        requestId: options.requestId,
        routingMode: options.routingMode,
        routingReason: options.routingReason,
        cacheKeyVersion: options.cacheKeyVersion,
        fallbackUsed: false,
        agentId: options.agentId,
        stage: options.stage,
      });

      llmMetricsCollector.record({
        provider: options.provider,
        model: options.model,
        latencyMs: Date.now() - options.startedAt,
        errorFlag: false,
        cacheHit: true,
        costEstimate: 0,
        operationType: options.operation,
        demandId: options.demandId,
        requestId: options.requestId,
        metadata: { cacheType: 'semantic', similarity: semanticHit.similarity },
      });

      logger.debug('Semantic cache hit in generate()', {
        context: {
          similarity: semanticHit.similarity.toFixed(4),
          operation: options.operation,
          model: options.model,
        },
      });

      return {
        content: semanticHit.response,
        metadata: {
          modelUsed: options.model,
          provider: options.provider,
          originalModel: options.originalModel,
          fallbackUsed: false,
          fallbackReason: null,
          routingMode: options.routingMode,
          routingReason: options.routingReason,
          cacheHit: true,
          semanticCacheHit: true,
          semanticSimilarity: semanticHit.similarity,
          promptTokens: 0,
          completionTokens: 0,
          costEstimate: 0,
        },
      };
    }
  } catch (_) {
    // Semantic cache failure is non-fatal; fall through to LLM
  }

  return null;
}
