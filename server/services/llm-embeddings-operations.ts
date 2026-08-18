/**
 * LLM Embeddings Operations
 *
 * Gerencia operações de embeddings:
 * - Geração de embeddings (local e remoto)
 * - Batch processing
 * - Matryoshka truncation e re-normalização
 * - Fallback para embeddings locais
 * - Telemetria de uso e custo
 */

import { logger } from '../utils/logger';
import { generateRequestId } from '../utils/request-id';
import {
  aiUsageTracker,
  estimateCost,
  estimateTextTokens,
  type RoutingMode,
} from './ai-usage-tracker';
import { circuitBreaker } from './circuit-breaker';
import { llmClientManager, type AIProvider } from './llm-client-manager';
import { generateLocalEmbedding } from './llm-local-embeddings';
import { errorHandlingManager } from './llm-observability';
import { embeddingProviderTotal, embeddingDegradedTotal } from '../metrics';

export interface EmbeddingOptions {
  text: string;
  provider?: AIProvider;
  model?: string;
  useLocal?: boolean;
}

export interface BatchEmbeddingOptions {
  texts: string[];
  provider?: AIProvider;
  model?: string;
  useLocal?: boolean;
  concurrency?: number;
}

export const DEFAULT_EMBEDDING_MODEL = 'qwen/qwen3-embedding-8b';
export const EMBEDDING_DIMENSION = 3072;
const MAX_EMBEDDING_INPUT_LENGTH = 8000;
const REMOTE_EMBEDDING_TIMEOUT_MS = 15_000;

export class EmbeddingsManager {
  /**
   * EMB-003: Internal transient-degradation flag. Set when a remote
   * embedding call fails and we fall back to local. This replaces the old
   * `process.env.EMBEDDING_PROVIDER = 'local'` mutation, which was global,
   * sticky (never reverted), and leaked across requests/tests. This flag is
   * per-instance and only signals that the NEXT call should try remote
   * again (it does NOT force local — `shouldUseLocalEmbeddings()` is still
   * the authority on provider selection).
   */
  private transientDegradedToLocal = false;

  /**
   * Returns true when the embedding subsystem is currently operating in a
   * degraded state — either persistently (configured for local) or
   * transiently (a remote call failed and we fell back). Callers (RAG,
   * health check, UI) should use this to surface the degradation honestly
   * instead of presenting lexical results as semantic.
   */
  isDegraded(): boolean {
    return this.transientDegradedToLocal || this.shouldUseLocalEmbeddings();
  }

  /**
   * Retorna o model ID de embedding ativo (env ou default).
   */
  getEmbeddingModel(): string {
    return process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
  }

  /**
   * Retorna a dimensão fixa esperada para os embeddings.
   */
  getEmbeddingDimensions(): number {
    return EMBEDDING_DIMENSION;
  }

  /**
   * Gera embedding para um único texto (local ou remoto).
   */
  async generateEmbedding(options: EmbeddingOptions): Promise<number[]> {
    const { text, model = process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL } = options;
    const startedAt = Date.now();
    const requestId = generateRequestId();
    const useLocalEmbedding = options.useLocal ?? this.shouldUseLocalEmbeddings();

    const providerName = (process.env.EMBEDDING_PROVIDER || 'auto').toLowerCase();
    const actualProvider: AIProvider =
      options.provider ?? (providerName === 'openrouter' ? 'openrouter' : 'openai');
    const client = useLocalEmbedding ? null : llmClientManager.getClient(actualProvider);

    const routingMode: RoutingMode = 'unknown';
    const routingReason: string | null = null;
    const fallbackUsed = false;
    const cacheKeyVersion: string | null = null;

    try {
      if (useLocalEmbedding || !client) {
        const embedding = this.generateLocalEmbedding(text);
        embeddingProviderTotal
          .labels('local', useLocalEmbedding ? 'true' : 'false', 'single')
          .inc();
        aiUsageTracker.record({
          timestamp: new Date().toISOString(),
          operation: 'embedding:local',
          model: 'local:feature-hash-3072',
          promptTokens: estimateTextTokens(text),
          completionTokens: 0,
          totalTokens: estimateTextTokens(text),
          estimatedCostUsd: 0,
          cacheHit: false,
          estimatedTokensSaved: 0,
          estimatedCostSavedUsd: null,
          latencyMs: Date.now() - startedAt,
          requestId,
          routingMode,
          routingReason,
          cacheKeyVersion,
          fallbackUsed,
        });
        return embedding;
      }

      const response = await circuitBreaker.execute(
        actualProvider,
        async () =>
          client.embeddings.create({
            model,
            input: text.slice(0, MAX_EMBEDDING_INPUT_LENGTH),
            encoding_format: 'float',
          }),
        { timeout: REMOTE_EMBEDDING_TIMEOUT_MS },
      );

      let embedding = response.data[0]?.embedding;
      if (!embedding) {
        throw new Error('No embedding returned from AI');
      }

      embedding = this.normalizeEmbedding(embedding);

      const promptTokens = response.usage?.prompt_tokens ?? estimateTextTokens(text);
      const costEstimate = await estimateCost(`${actualProvider}:${model}`, promptTokens, 0);

      embeddingProviderTotal.labels(actualProvider, 'false', 'single').inc();

      // EMB-003/P1-03: Reset the transient degraded flag on a successful
      // remote call. Without this, the flag sticks at 'true' forever after
      // a single failure, so the system never recovers even after the
      // remote provider is healthy again.
      if (this.transientDegradedToLocal) {
        this.transientDegradedToLocal = false;
        embeddingDegradedTotal.labels('recovered').inc();
        logger.info('Embedding subsystem recovered — remote call succeeded', {
          context: { provider: actualProvider, model },
        });
      }

      aiUsageTracker.record({
        timestamp: new Date().toISOString(),
        operation: 'embedding',
        model: `${actualProvider}:${model}`,
        promptTokens,
        completionTokens: 0,
        totalTokens: promptTokens,
        estimatedCostUsd: costEstimate.listCostUsd,
        pricingSource: costEstimate.pricingSource,
        pricingUpdatedAt: costEstimate.pricingUpdatedAt,
        billedCostUsd: costEstimate.billedCostUsd,
        creditAppliedUsd: costEstimate.creditAppliedUsd,
        isEstimated: costEstimate.isEstimated,
        cacheHit: false,
        estimatedTokensSaved: 0,
        estimatedCostSavedUsd: null,
        latencyMs: Date.now() - startedAt,
        requestId,
        routingMode,
        routingReason,
        cacheKeyVersion,
        fallbackUsed,
      });

      return embedding;
    } catch (error) {
      // Spec 10172-hotfix: fallback local sempre que o remoto falhar,
      // independentemente do provider configurado. Evita que timeouts da API
      // paralisem o processamento de demandas.
      this.transientDegradedToLocal = true;
      embeddingDegradedTotal.labels('remote_single_failed').inc();
      embeddingProviderTotal.labels('local', 'true', 'single_fallback').inc();
      errorHandlingManager?.logSanitized?.(
        error,
        {
          message: 'Embedding failed; using local 3072d fallback embedding (degraded)',
        },
        'warn',
      );
      return this.generateLocalEmbedding(text);
    }
  }

  /**
   * Gera embeddings para múltiplos textos em batch.
   */
  async generateEmbeddings(options: BatchEmbeddingOptions): Promise<number[][]> {
    const { texts, model = process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL } =
      options;

    if (texts.length === 0) return [];

    const startedAt = Date.now();
    const requestId = generateRequestId();
    const truncatedTexts = texts.map((t) => t.slice(0, MAX_EMBEDDING_INPUT_LENGTH));
    const useLocalEmbedding = options.useLocal ?? this.shouldUseLocalEmbeddings();

    const providerName = (process.env.EMBEDDING_PROVIDER || 'auto').toLowerCase();
    const actualProvider: AIProvider =
      options.provider ?? (providerName === 'openrouter' ? 'openrouter' : 'openai');
    const client = useLocalEmbedding ? null : llmClientManager.getClient(actualProvider);

    const routingMode: RoutingMode = 'unknown';
    const routingReason: string | null = null;
    const fallbackUsed = false;
    const cacheKeyVersion: string | null = null;

    try {
      if (useLocalEmbedding || !client) {
        embeddingProviderTotal.labels('local', useLocalEmbedding ? 'true' : 'false', 'batch').inc();
        return truncatedTexts.map((text) => this.generateLocalEmbedding(text));
      }

      const response = await circuitBreaker.execute(
        actualProvider,
        async () =>
          client.embeddings.create({
            model,
            input: truncatedTexts,
            encoding_format: 'float',
          }),
        { timeout: REMOTE_EMBEDDING_TIMEOUT_MS },
      );

      const embeddings = response.data
        .sort((a, b) => a.index - b.index)
        .map((item) => this.normalizeEmbedding(item.embedding));

      const promptTokens = response.usage?.prompt_tokens ?? 0;
      const costEstimate = await estimateCost(`${actualProvider}:${model}`, promptTokens, 0);

      embeddingProviderTotal.labels(actualProvider, 'false', 'batch').inc();

      // EMB-003/P1-03: Reset the transient degraded flag on successful
      // batch call (same as single path).
      if (this.transientDegradedToLocal) {
        this.transientDegradedToLocal = false;
        embeddingDegradedTotal.labels('recovered').inc();
        logger.info('Embedding subsystem recovered — remote batch call succeeded', {
          context: { provider: actualProvider, model },
        });
      }

      aiUsageTracker.record({
        timestamp: new Date().toISOString(),
        operation: 'embedding:batch',
        model: `${actualProvider}:${model}`,
        promptTokens,
        completionTokens: 0,
        totalTokens: promptTokens,
        estimatedCostUsd: costEstimate.listCostUsd,
        pricingSource: costEstimate.pricingSource,
        pricingUpdatedAt: costEstimate.pricingUpdatedAt,
        billedCostUsd: costEstimate.billedCostUsd,
        creditAppliedUsd: costEstimate.creditAppliedUsd,
        isEstimated: costEstimate.isEstimated,
        cacheHit: false,
        estimatedTokensSaved: 0,
        estimatedCostSavedUsd: null,
        latencyMs: Date.now() - startedAt,
        requestId,
        routingMode,
        routingReason,
        cacheKeyVersion,
        fallbackUsed,
      });

      return embeddings;
    } catch (error) {
      if (
        process.env.EMBEDDING_PROVIDER !== 'openai' &&
        process.env.EMBEDDING_PROVIDER !== 'openrouter'
      ) {
        // EMB-003: do NOT mutate process.env — set internal transient flag.
        this.transientDegradedToLocal = true;
        embeddingDegradedTotal.labels('remote_batch_failed').inc();
        // P1-03: Track the local fallback in the provider metric.
        embeddingProviderTotal.labels('local', 'true', 'batch_fallback').inc();
        errorHandlingManager.logSanitized(
          error,
          {
            message: 'AI batch embedding failed; using local 3072d fallback embeddings (degraded)',
          },
          'warn',
        );
        return truncatedTexts.map((text) => this.generateLocalEmbedding(text));
      }
      errorHandlingManager.logSanitized(error, {
        message: 'AI batch embedding failed',
      });
      throw new Error(
        `Failed to generate embeddings: ${errorHandlingManager.getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Determina se deve usar embeddings locais.
   */
  shouldUseLocalEmbeddings(): boolean {
    const provider = (process.env.EMBEDDING_PROVIDER || 'auto').toLowerCase();
    if (provider === 'local') {
      return true;
    }
    if (provider === 'openai' || provider === 'openrouter') {
      return false;
    }
    try {
      const { featureFlags } = require('./feature-flags');
      const flags = featureFlags.getFlags();
      if (flags.enableLocalEmbeddings === true) {
        return true;
      }
    } catch (_) {
      /* ignora — fallback para verificação de client */
    }
    return !llmClientManager.hasClient('openai') && !llmClientManager.hasClient('openrouter');
  }

  isUsingLocalEmbeddings(): boolean {
    return this.shouldUseLocalEmbeddings();
  }

  /**
   * Local embeddings are a performance fallback (hash-based, lexical similarity).
   * They are NOT semantically equivalent to transformer-based embeddings.
   * By default, they are NOT used for critical RAG paths.
   */
  isUsingLocalEmbeddingsForRAG(): boolean {
    if (!this.shouldUseLocalEmbeddings()) {
      return false;
    }
    try {
      const { featureFlags } = require('./feature-flags');
      return featureFlags.getFlags().enableLocalEmbeddingsForRAG === true;
    } catch (_) {
      return false;
    }
  }

  private generateLocalEmbedding(text: string): number[] {
    return generateLocalEmbedding(text);
  }

  private normalizeEmbedding(embedding: number[]): number[] {
    // EMB-003: Dimension validation. The vector store and cosine similarity
    // both require exactly EMBEDDING_DIMENSION (3072) elements. Previously,
    // embeddings shorter than 3072 were passed through unchanged, which made
    // cosineSimilarity silently return 0 (mismatched lengths) — a
    // hard-to-diagnose recall failure. Now we pad with zeros AND re-normalize
    // so the result is always a valid 3072-d unit vector.
    if (embedding.length === EMBEDDING_DIMENSION) {
      return embedding;
    }

    let adjusted: number[];
    if (embedding.length > EMBEDDING_DIMENSION) {
      // Matryoshka truncation: Qwen3-Embedding-8B 4096 -> 3072
      adjusted = embedding.slice(0, EMBEDDING_DIMENSION);
    } else {
      // Pad shorter embeddings (e.g. 1536d text-embedding-3-small) to 3072.
      // This is a lossy projection but keeps cosine similarity well-defined
      // instead of silently returning 0.
      adjusted = [...embedding, ...new Array(EMBEDDING_DIMENSION - embedding.length).fill(0)];
    }

    const norm = Math.sqrt(adjusted.reduce((sum, val) => sum + val * val, 0));
    if (norm > 0) {
      return adjusted.map((val) => val / norm);
    }
    // Zero-norm vector — return as-is (all zeros); cosine will be 0, which
    // is the correct mathematical result for a zero vector, not a silent
    // dimension-mismatch bug.
    return adjusted;
  }
}

export const embeddingsManager = new EmbeddingsManager();
