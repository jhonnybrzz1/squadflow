/**
 * Semantic Cache Service
 *
 * Extends the existing exact-match AI cache with embedding-based similarity
 * lookup. When an exact cache miss occurs, checks if a semantically similar
 * query was recently answered and returns that response.
 *
 * Architecture:
 * 1. Exact match (SHA-256 key) — checked first by existing AIResponseCache
 * 2. Semantic match (cosine similarity ≥ threshold) — checked by this service
 *
 * Design constraints:
 * - In-memory store with configurable max entries and TTL
 * - Embedding generation is async; if it fails, falls through to LLM call
 * - Only caches non-streaming, non-JSON responses (to avoid stale structured data)
 * - Thread-safe via sequential async operations
 *
 * Estimated savings: 20-40% reduction in LLM costs for similar queries.
 */

import crypto from 'crypto';
import { env } from '../config/env';
import { embeddingService } from './embedding-service';
import { embeddingsManager } from './llm-embeddings-operations';
import { logger } from '../utils/logger';
import { metricsCollector } from '../metrics/collector';
import { ICacheStore, getCacheStore } from './cache-adapter';
import { featureFlags } from './feature-flags';

/** Versão do namespace semântico — bump invalida com segurança entradas antigas. */
export const SEMANTIC_NAMESPACE_VERSION = 'v3';

/**
 * Spec 015 (H-04): fingerprint estável das dimensões que alteram a saída.
 * Spec 10259 T5: quando um prompt externo versionado é fornecido, o hash
 * SHA-256 do conteúdo bruto do arquivo entra no fingerprint — invalidando
 * cache quando o arquivo muda sem depender de variáveis dinâmicas do request.
 *
 * Auditoria 2026-08-01 (A09): o promptHash era usado **em vez de**
 * `systemMessages` (`promptHash ?? systemMessages`). Como o prompt efetivo vem
 * de YAML/DB e do contexto dinâmico — e não só do arquivo em disco — dois
 * prompts efetivos diferentes colidiam na mesma chave sempre que o agente
 * tivesse um arquivo versionado. Agora as duas dimensões entram no hash: o
 * arquivo invalida por versão, as mensagens renderizadas isolam por conteúdo.
 * `SEMANTIC_NAMESPACE_VERSION` foi para `v3` para descartar as entradas
 * gravadas com a chave antiga.
 *
 * Retorna null quando o contexto não é serializável — o chamador DEVE então
 * desativar o cache semântico para a operação (FR-003).
 */
export function computeContextFingerprint(input: {
  systemMessages: unknown;
  cacheContext: unknown;
  temperature?: number | null;
  maxTokens?: number | null;
  responseFormat?: string | null;
  /** Spec 10259 T5: hash SHA-256 do conteúdo bruto do system prompt. */
  promptHash?: string | null;
}): string | null {
  try {
    const canonical = JSON.stringify([
      SEMANTIC_NAMESPACE_VERSION,
      input.promptHash ?? null,
      input.systemMessages ?? null,
      input.cacheContext ?? null,
      input.temperature ?? null,
      input.maxTokens ?? null,
      input.responseFormat ?? 'text',
    ]);
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  } catch (_) {
    return null;
  }
}

export function canonicalizeQuery(queryText: string): string {
  return queryText.trim().replace(/\s+/g, ' ');
}

export interface SemanticCacheEntry {
  queryEmbedding: number[];
  queryText: string;
  response: string;
  model: string;
  operation: string;
  /**
   * Spec 10147: modelo e dimensão de embedding usados para gerar o vetor.
   * Garante isolamento entre espaços vetoriais distintos.
   */
  embeddingModel: string;
  dimensions: number;
  /**
   * Spec 015 (H-04): hash estável do contexto que altera a saída (system
   * messages, cacheContext, temperatura, maxTokens, versão de namespace).
   * Entradas legadas sem fingerprint NUNCA são elegíveis para hit.
   */
  contextFingerprint?: string;
  /**
   * M-1: versão do corpus no momento da criação. Entradas com versão
   * inferior à currentCorpusVersion são purgadas lazy no acesso.
   */
  corpusVersion: number;
  createdAt: number;
  expiresAt: number;
  hits: number;
}

interface SemanticCacheStats {
  enabled: boolean;
  size: number;
  maxEntries: number;
  ttlMs: number;
  similarityThreshold: number;
  totalHits: number;
  totalMisses: number;
  totalEmbeddingFailures: number;
  staleCount: number;
  currentCorpusVersion: number;
  hitRate: number;
  backingStore: 'memory' | 'redis' | 'memory+redis';
}

export interface SemanticCacheOptions {
  /** Minimum cosine similarity to consider a hit (default: 0.90) */
  similarityThreshold?: number;
  /** Maximum entries in cache (default: 200) */
  maxEntries?: number;
  /** TTL in milliseconds (default: 30 minutes) */
  ttlMs?: number;
  /** Enable/disable (default: true) */
  enabled?: boolean;
}

/**
 * Serialised form of a semantic cache entry stored in Redis.
 * Includes the embedding vector so the index can be rebuilt on cold start.
 */
interface SerializedIndexEntry {
  queryEmbedding: number[];
  queryText: string;
  response: string;
  model: string;
  operation: string;
  contextFingerprint?: string;
  /**
   * Spec 10147: modelo e dimensão de embedding para validação no rebuild.
   */
  embeddingModel: string;
  dimensions: number;
  /**
   * M-1: versão do corpus no momento da criação.
   */
  corpusVersion: number;
  createdAt: number;
  expiresAt: number;
}

const DEFAULT_THRESHOLD = 0.85;

export class SemanticCacheService {
  private readonly entries: SemanticCacheEntry[] = [];
  private readonly similarityThreshold: number;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly enabled: boolean;

  private totalHits = 0;
  private totalMisses = 0;
  private totalEmbeddingFailures = 0;
  /** M-1: total de entradas descartadas por stale corpus version. */
  private staleCount = 0;
  /** M-1: versão global do corpus; entradas criadas com versão inferior são stale. */
  private currentCorpusVersion = 1;

  /**
   * Optional distributed backing store (Redis).
   * Stores serialised response payloads so data survives restarts and is
   * shared across multiple server instances. The embedding index stays
   * in-memory (each instance rebuilds it), but cached responses are persisted.
   */
  private backingStore: ICacheStore | null = null;
  private backingStoreType: 'memory' | 'redis' = 'memory';

  constructor(options: SemanticCacheOptions = {}) {
    // Spec 10125 #14: unified threshold from env with safe minimum floor.
    this.similarityThreshold = Math.max(
      DEFAULT_THRESHOLD,
      options.similarityThreshold ?? env.aiCacheThreshold,
    );
    this.maxEntries = options.maxEntries ?? env.semanticCacheMaxEntries;
    this.ttlMs = options.ttlMs ?? env.semanticCacheTtlMs;
    this.enabled = options.enabled ?? env.semanticCacheEnabled;

    logger.info('SemanticCacheService initialized', {
      context: {
        similarityThreshold: this.similarityThreshold,
        maxEntries: this.maxEntries,
        ttlMs: this.ttlMs,
        enabled: this.enabled,
        corpusVersion: this.currentCorpusVersion,
      },
    });
  }

  /** M-1: retorna a versão atual do corpus. */
  getCurrentCorpusVersion(): number {
    return this.currentCorpusVersion;
  }

  /**
   * M-1: incrementa atomicamente a versão do corpus e persiste no Redis
   * se houver backing store. Deve ser chamado ao final de cada batch update.
   */
  async incrementCorpusVersion(): Promise<number> {
    this.currentCorpusVersion += 1;

    if (this.backingStore && this.backingStore.isReady()) {
      await this.backingStore.set('semantic:corpus:version', String(this.currentCorpusVersion));
    }

    logger.info('M-1: corpus version incremented', {
      context: { corpusVersion: this.currentCorpusVersion },
    });

    return this.currentCorpusVersion;
  }

  /**
   * M-1: define manualmente a versão do corpus (ex: flush ou inicialização).
   * Rejeita explicitamente corpus_version=0.
   */
  async setCorpusVersion(version: number): Promise<number> {
    if (version === 0) {
      throw new Error('M-1: corpus_version=0 é inválido');
    }
    this.currentCorpusVersion = version;

    if (this.backingStore && this.backingStore.isReady()) {
      await this.backingStore.set('semantic:corpus:version', String(this.currentCorpusVersion));
    }

    logger.info('M-1: corpus version set', {
      context: { corpusVersion: this.currentCorpusVersion },
    });

    return this.currentCorpusVersion;
  }

  /**
   * Initialise the distributed backing store (Redis when REDIS_URL is set).
   * When Redis contains persisted index entries, rebuilds the in-memory
   * embedding index so similarity search works immediately on cold start.
   * Safe to call multiple times — only initialises once.
   */
  async initBackingStore(): Promise<void> {
    if (this.backingStore) return;
    try {
      const store = await getCacheStore();
      this.backingStore = store;
      this.backingStoreType = store.getStats().type;
      if (this.backingStoreType === 'redis') {
        logger.info('SemanticCacheService: Redis backing store enabled');
        const versionStr = await this.backingStore.get('semantic:corpus:version');
        if (versionStr) {
          const version = parseInt(versionStr, 10);
          if (!Number.isNaN(version) && version > 0) {
            this.currentCorpusVersion = version;
          }
        }
        await this.rebuildIndexFromStore();
      }
    } catch (_) {
      // fallback: pure in-memory
    }
  }

  /**
   * Rebuild the in-memory embedding index from persisted Redis entries.
   * Scans for `semantic-index:*` keys, deserialises them, and populates
   * the entries array. Expired entries are skipped.
   *
   * This eliminates the cold-start penalty: the similarity search is
   * functional immediately after restart without re-calling the embedding API.
   */
  private async rebuildIndexFromStore(): Promise<void> {
    if (!this.backingStore || !this.backingStore.isReady()) return;

    const activeModel = embeddingsManager.getEmbeddingModel();
    const activeDimensions = embeddingsManager.getEmbeddingDimensions();

    const startMs = Date.now();
    try {
      const persisted = await this.backingStore.scan('semantic-index:*', this.maxEntries);

      const now = Date.now();
      let loaded = 0;
      for (const { value } of persisted) {
        try {
          const entry = JSON.parse(value) as SerializedIndexEntry;
          // Skip expired
          if (entry.expiresAt <= now) continue;
          // Skip if we already have too many
          if (this.entries.length >= this.maxEntries) break;
          // Validate embedding is a non-empty array
          if (!Array.isArray(entry.queryEmbedding) || entry.queryEmbedding.length === 0) continue;
          // Spec 10147: descarta vetores de modelos/dimensões diferentes.
          if (entry.embeddingModel !== activeModel || entry.dimensions !== activeDimensions)
            continue;

          this.entries.push({
            queryEmbedding: entry.queryEmbedding,
            contextFingerprint: entry.contextFingerprint,
            queryText: entry.queryText,
            response: entry.response,
            model: entry.model,
            operation: entry.operation,
            embeddingModel: entry.embeddingModel,
            dimensions: entry.dimensions,
            corpusVersion: entry.corpusVersion ?? 1,
            createdAt: entry.createdAt,
            expiresAt: entry.expiresAt,
            hits: 0,
          });
          loaded++;
        } catch (_) {
          // Skip malformed entries
        }
      }

      if (loaded > 0) {
        logger.info('SemanticCacheService: rebuilt embedding index from Redis', {
          context: {
            entriesLoaded: loaded,
            totalScanned: persisted.length,
            durationMs: Date.now() - startMs,
          },
        });
      }
    } catch (error) {
      logger.warn('SemanticCacheService: failed to rebuild index from Redis', {
        context: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  /**
   * Try to find a cached response for a semantically similar query.
   *
   * @param queryText - The user's query
   * @param model - The model being used (must match)
   * @param operation - The operation type (must match)
   * @returns Cached response if found, null otherwise
   */
  async get(
    queryText: string,
    model: string,
    operation: string,
    contextFingerprint?: string,
  ): Promise<{ response: string; similarity: number; originalQuery: string } | null> {
    // Sem fingerprint não há como provar isolamento — nenhum hit (FR-003).
    if (!contextFingerprint) {
      return null;
    }
    if (!this.enabled || this.entries.length === 0) {
      return null;
    }

    const canonicalQueryText = canonicalizeQuery(queryText);

    // Lê threshold dinamicamente da feature-flag (hot-reload, sem restart)
    // Garante que nunca fique abaixo do mínimo seguro de 0.85
    let effectiveThreshold = this.similarityThreshold;
    try {
      const flags = featureFlags.getFlags();
      if (typeof flags.semanticCacheSimilarityThreshold === 'number') {
        effectiveThreshold = Math.max(0.85, flags.semanticCacheSimilarityThreshold);
      }
    } catch (_) {
      /* usa o threshold do construtor como fallback */
    }

    // Generate embedding for the query
    let queryEmbedding: number[];
    try {
      queryEmbedding = await embeddingService.getEmbedding(canonicalQueryText);
    } catch (_) {
      this.totalEmbeddingFailures++;
      return null;
    }

    this.pruneExpired();

    // Spec 10147: isolamento por embedding model + dimensions em runtime
    const activeEmbeddingModel = embeddingsManager.getEmbeddingModel();
    const activeDimensions = embeddingsManager.getEmbeddingDimensions();

    // Search for similar entries (same model + operation + embedding space)
    let bestMatch: { entry: SemanticCacheEntry; similarity: number } | null = null;
    // A-1: near-match com mesmo embedding mas metadata divergente (model/op/fingerprint/embedding).
    let nearMismatch: { entry: SemanticCacheEntry; similarity: number } | null = null;

    for (const entry of this.entries) {
      const similarity = embeddingService.cosineSimilarity(queryEmbedding, entry.queryEmbedding);

      if (similarity < effectiveThreshold) {
        continue;
      }

      // A-1: detecta mismatch antes do filtro, para baseline.
      const mismatched =
        entry.model !== model ||
        entry.operation !== operation ||
        entry.contextFingerprint !== contextFingerprint ||
        entry.embeddingModel !== activeEmbeddingModel ||
        entry.dimensions !== activeDimensions;

      if (mismatched) {
        if (!nearMismatch || similarity > nearMismatch.similarity) {
          nearMismatch = { entry, similarity };
        }
        continue;
      }

      if (!bestMatch || similarity > bestMatch.similarity) {
        bestMatch = { entry, similarity };
      }
    }

    if (nearMismatch) {
      logger.info('A-1: semantic cache near-mismatch detected', {
        context: {
          requestedModel: model,
          cachedModel: nearMismatch.entry.model,
          requestedOperation: operation,
          cachedOperation: nearMismatch.entry.operation,
          requestedFingerprint: contextFingerprint,
          cachedFingerprint: nearMismatch.entry.contextFingerprint,
          requestedEmbeddingModel: activeEmbeddingModel,
          cachedEmbeddingModel: nearMismatch.entry.embeddingModel,
          requestedDimensions: activeDimensions,
          cachedDimensions: nearMismatch.entry.dimensions,
          mismatch: true,
          similarity: nearMismatch.similarity.toFixed(4),
        },
      });
    }

    if (bestMatch) {
      // M-1: lazy purge por corpus version
      if (bestMatch.entry.corpusVersion < this.currentCorpusVersion) {
        this.staleCount++;
        this.totalMisses++;
        this.removeEntry(bestMatch.entry);

        logger.info('M-1: semantic cache stale purge', {
          context: {
            requestedModel: model,
            cachedModel: bestMatch.entry.model,
            operation,
            entryCorpusVersion: bestMatch.entry.corpusVersion,
            currentCorpusVersion: this.currentCorpusVersion,
            staleCount: this.staleCount,
            originalQuery: bestMatch.entry.queryText.slice(0, 50),
            newQuery: queryText.slice(0, 50),
          },
        });

        return null;
      }

      bestMatch.entry.hits++;
      this.totalHits++;
      metricsCollector.recordCacheHit();

      logger.info('A-1: semantic cache hit', {
        context: {
          requestedModel: model,
          cachedModel: bestMatch.entry.model,
          mismatch: false,
          similarity: bestMatch.similarity.toFixed(4),
          operation,
          corpusVersion: this.currentCorpusVersion,
          originalQuery: bestMatch.entry.queryText.slice(0, 50),
          newQuery: queryText.slice(0, 50),
        },
      });

      // If the in-memory entry lost its response (e.g. after restart with
      // Redis backing), try to recover it from distributed store
      let response = bestMatch.entry.response;
      if (!response && this.backingStore && this.backingStore.isReady()) {
        try {
          const key = this.buildRedisKey(
            bestMatch.entry.queryText,
            model,
            operation,
            contextFingerprint,
            bestMatch.entry.embeddingModel,
            bestMatch.entry.dimensions,
          );
          const remote = await this.backingStore.get(key);
          if (remote) {
            bestMatch.entry.response = remote;
            response = remote;
          }
        } catch (_) {
          /* non-fatal */
        }
      }

      if (!response) {
        this.totalMisses++;
        return null;
      }

      return {
        response,
        similarity: bestMatch.similarity,
        originalQuery: bestMatch.entry.queryText,
      };
    }

    this.totalMisses++;

    logger.info('M-1: semantic cache miss', {
      context: {
        requestedModel: model,
        operation,
        corpusVersion: this.currentCorpusVersion,
        newQuery: queryText.slice(0, 50),
      },
    });

    return null;
  }

  /** M-1: remove uma entrada do cache (memória + Redis). */
  private removeEntry(target: SemanticCacheEntry): void {
    const idx = this.entries.indexOf(target);
    if (idx >= 0) {
      this.entries.splice(idx, 1);
    }

    if (this.backingStore && this.backingStore.isReady()) {
      const key = this.buildRedisKey(
        target.queryText,
        target.model,
        target.operation,
        target.contextFingerprint ?? '',
        target.embeddingModel,
        target.dimensions,
      );
      const indexKey = this.buildIndexKey(
        target.queryText,
        target.model,
        target.operation,
        target.contextFingerprint ?? '',
        target.embeddingModel,
        target.dimensions,
      );
      this.backingStore.del(key).catch(() => {});
      this.backingStore.del(indexKey).catch(() => {});
    }
  }

  /**
   * Store a query-response pair in the semantic cache.
   *
   * @param queryText - The query text
   * @param response - The LLM response
   * @param model - The model used
   * @param operation - The operation type
   * @param ttlMs - Optional custom TTL
   */
  async set(
    queryText: string,
    response: string,
    model: string,
    operation: string,
    ttlMs?: number,
    contextFingerprint?: string,
  ): Promise<void> {
    if (!this.enabled || !response.trim()) {
      return;
    }
    // Sem fingerprint seguro, não gravar — evita entradas que nunca poderão
    // provar isolamento contextual (FR-003).
    if (!contextFingerprint) {
      return;
    }

    // Skip caching very short responses (likely errors)
    if (response.length < 20) {
      return;
    }

    const canonicalQueryText = canonicalizeQuery(queryText);

    // M-1: rejeita corpus_version=0 de forma explícita
    if (this.currentCorpusVersion === 0) {
      logger.warn('M-1: tentativa de cache com corpus_version=0 — rejeitada', {
        context: { query: canonicalQueryText.slice(0, 50) },
      });
      return;
    }

    // Generate embedding for the query
    let queryEmbedding: number[];
    try {
      queryEmbedding = await embeddingService.getEmbedding(canonicalQueryText);
    } catch (_) {
      this.totalEmbeddingFailures++;
      return;
    }

    const now = Date.now();
    const effectiveTtl = ttlMs ?? this.ttlMs;
    const activeEmbeddingModel = embeddingsManager.getEmbeddingModel();
    const activeDimensions = embeddingsManager.getEmbeddingDimensions();

    // Check if we already have a very similar entry (avoid duplicates)
    for (const entry of this.entries) {
      if (
        entry.model === model &&
        entry.operation === operation &&
        entry.contextFingerprint === contextFingerprint &&
        entry.embeddingModel === activeEmbeddingModel &&
        entry.dimensions === activeDimensions
      ) {
        const similarity = embeddingService.cosineSimilarity(queryEmbedding, entry.queryEmbedding);
        if (similarity >= 0.98) {
          // Update existing entry instead of adding duplicate
          entry.response = response;
          entry.expiresAt = now + effectiveTtl;
          entry.corpusVersion = this.currentCorpusVersion;
          return;
        }
      }
    }

    // Add new entry
    this.entries.push({
      queryEmbedding,
      queryText: canonicalQueryText,
      response,
      model,
      operation,
      embeddingModel: activeEmbeddingModel,
      dimensions: activeDimensions,
      contextFingerprint,
      corpusVersion: this.currentCorpusVersion,
      createdAt: now,
      expiresAt: now + effectiveTtl,
      hits: 0,
    });

    this.prune();

    // Write-through to distributed store (fire-and-forget)
    if (this.backingStore && this.backingStore.isReady()) {
      const redisKey = this.buildRedisKey(
        canonicalQueryText,
        model,
        operation,
        contextFingerprint,
        activeEmbeddingModel,
        activeDimensions,
      );
      const indexKey = this.buildIndexKey(
        canonicalQueryText,
        model,
        operation,
        contextFingerprint,
        activeEmbeddingModel,
        activeDimensions,
      );

      // Persist response (lightweight, for response-only lookups)
      this.backingStore.set(redisKey, response, effectiveTtl).catch(() => {
        /* non-fatal */
      });

      // Persist full index entry (embedding + metadata) for cold-start rebuild
      const indexPayload: SerializedIndexEntry = {
        queryEmbedding,
        queryText: canonicalQueryText,
        response,
        model,
        operation,
        contextFingerprint,
        embeddingModel: activeEmbeddingModel,
        dimensions: activeDimensions,
        corpusVersion: this.currentCorpusVersion,
        createdAt: now,
        expiresAt: now + effectiveTtl,
      };
      this.backingStore.set(indexKey, JSON.stringify(indexPayload), effectiveTtl).catch(() => {
        /* non-fatal */
      });
    }
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.entries.length = 0;
    this.totalHits = 0;
    this.totalMisses = 0;
    this.totalEmbeddingFailures = 0;

    // Also clear distributed store
    if (this.backingStore && this.backingStore.isReady()) {
      this.backingStore.clear().catch(() => {
        /* non-fatal */
      });
    }
  }

  /**
   * Get cache statistics.
   */
  getStats(): SemanticCacheStats {
    this.pruneExpired();
    const totalRequests = this.totalHits + this.totalMisses;
    const storeType = this.backingStoreType;
    const backingStore: SemanticCacheStats['backingStore'] =
      storeType === 'redis' ? 'memory+redis' : 'memory';

    return {
      enabled: this.enabled,
      size: this.entries.length,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      similarityThreshold: this.similarityThreshold,
      totalHits: this.totalHits,
      totalMisses: this.totalMisses,
      totalEmbeddingFailures: this.totalEmbeddingFailures,
      staleCount: this.staleCount,
      currentCorpusVersion: this.currentCorpusVersion,
      hitRate: totalRequests > 0 ? this.totalHits / totalRequests : 0,
      backingStore,
    };
  }

  /**
   * Remove expired entries.
   */
  private pruneExpired(): void {
    const now = Date.now();
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].expiresAt <= now) {
        this.entries.splice(i, 1);
      }
    }
  }

  /**
   * Evict oldest entries when over capacity.
   */
  private prune(): void {
    this.pruneExpired();

    // Evict least-recently-used entries
    while (this.entries.length > this.maxEntries) {
      // Find entry with fewest hits (LFU eviction)
      let minIdx = 0;
      let minHits = this.entries[0].hits;
      for (let i = 1; i < this.entries.length; i++) {
        if (this.entries[i].hits < minHits) {
          minHits = this.entries[i].hits;
          minIdx = i;
        }
      }
      this.entries.splice(minIdx, 1);
    }
  }

  /**
   * Build a deterministic Redis key for a semantic cache response.
   * Spec 10147: namespace inclui embedding model + dimensions para isolar
   * espaços vetoriais distintos.
   */
  private buildRedisKey(
    queryText: string,
    model: string,
    operation: string,
    contextFingerprint: string,
    embeddingModel: string,
    dimensions: number,
  ): string {
    const hash = crypto
      .createHash('sha256')
      .update(canonicalizeQuery(queryText))
      .digest('hex')
      .slice(0, 16);
    return `semantic:${embeddingModel}:${dimensions}:${model}:${operation}:${contextFingerprint}:${hash}`;
  }

  /**
   * Build a deterministic Redis key for the full index entry (embedding + metadata).
   * Uses a separate namespace (`semantic-index:`) so we can SCAN for all entries
   * during cold-start rebuild. Spec 10147: inclui embedding model + dimensions.
   */
  private buildIndexKey(
    queryText: string,
    model: string,
    operation: string,
    contextFingerprint: string,
    embeddingModel: string,
    dimensions: number,
  ): string {
    const hash = crypto
      .createHash('sha256')
      .update(canonicalizeQuery(queryText))
      .digest('hex')
      .slice(0, 16);
    return `semantic-index:${embeddingModel}:${dimensions}:${model}:${operation}:${contextFingerprint}:${hash}`;
  }
}

export const semanticCacheService = new SemanticCacheService();
