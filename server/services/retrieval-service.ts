import { sql, SQL } from 'drizzle-orm';
import { dbAll } from '../utils/db-utils';
import { db as defaultDb, DbClient } from '../db';
import { logger } from '../utils/logger';
import { embeddingsManager } from './llm-embeddings-operations';
import { vectorSearchService } from './vector-search';
import { llmReorderService } from './llm-reorder';
import { embeddingService } from './embedding-service';
import { ragFeedbackService } from './rag-feedback';
import { generateRequestId } from '../utils/request-id';
import { queryTypeWeightsService } from './query-type-weights';

export type RetrievalSource = 'refinement';

export interface RetrievalScope {
  repoFullName?: string | null;
  includeGlobal?: boolean;
}

export interface RetrievalPolicy {
  source: RetrievalSource;
  topK?: number;
  minSimilarity?: number;
  useReranking?: boolean;
  scope?: RetrievalScope;
  freshnessDays?: number;
  demandId?: number;
  agentName?: string;
  /** A-1: tipo da consulta para lookup de pesos híbridos. */
  queryType?: string;
  /** A-1: identificador de sessão para log de debug. */
  sessionId?: string;
  /** Spec 10259 T6: peso da busca lexical (0 a 1). */
  keywordWeight?: number;
  /** Spec 10259 T6: peso da busca semântica (0 a 1). */
  semanticWeight?: number;
}

export interface UnifiedRetrievalResult {
  id: string;
  sourceKey: string;
  docType: string;
  content: string;
  repoFullName: string | null;
  score: number;
  sectionHeader?: string;
  metadata?: Record<string, any>;
}

export class RetrievalService {
  constructor(private readonly database: DbClient = defaultDb) {}

  /**
   * Executa a busca vetorial unificada, aplicando regras de governança,
   * over-fetching para rerank, filtros de atualidade e fallback de SQLite.
   */
  async retrieve(query: string, policy: RetrievalPolicy): Promise<UnifiedRetrievalResult[]> {
    const topK = policy.topK ?? 4;
    const minSimilarity = policy.minSimilarity ?? 0.0;
    const source = policy.source;
    const retrievalStart = performance.now();

    // 1. Governança e Trava de Segurança dos Embeddings Locais (Não rodar em silêncio)
    // EMB-001: surface BOTH persistent (configured local) and transient
    // (remote failed → fell back) degradation. The RAG caller and downstream
    // consumers must not present lexical results as semantic.
    if (embeddingsManager.isUsingLocalEmbeddingsForRAG()) {
      logger.warn(
        'WARNING: RAG is using local hash-based embeddings! Semantic recall will be poor.',
        {
          context: { query, source, degradation: 'persistent' },
        },
      );
    } else if (embeddingsManager.isDegraded()) {
      logger.warn(
        'WARNING: RAG embedding provider is transiently degraded (remote failed → local fallback). Semantic recall may be reduced.',
        {
          context: { query, source, degradation: 'transient' },
        },
      );
    }

    // 2. Determina o total de fetch considerando over-fetching para Reranking
    // PRD: Rerank só reordena de forma útil se buscarmos um pool maior (over-fetch)
    const needsRerank = policy.useReranking && llmReorderService.isAvailable();
    // Incidente 2026-07-17: over-fetch de 30 docs inflava as search units do
    // rerank sem ganho no top-K típico (≤5). 2× com piso 15 preserva recall.
    const fetchK = needsRerank ? Math.max(15, topK * 2) : topK;

    // A-1: pesos por queryType com fallback para 0.5/0.5. Se o caller passou
    // keywordWeight/semanticWeight explicitamente, prevalece sobre o queryType.
    const queryWeights =
      policy.keywordWeight !== undefined || policy.semanticWeight !== undefined
        ? {
            keywordWeight: policy.keywordWeight ?? 0.5,
            semanticWeight: policy.semanticWeight ?? 0.5,
            matched: false,
          }
        : await queryTypeWeightsService.getWeights(policy.queryType);

    const keywordWeight = Math.max(0, Math.min(1, queryWeights.keywordWeight));
    const semanticWeight = Math.max(0, Math.min(1, queryWeights.semanticWeight));
    const totalWeight = keywordWeight + semanticWeight;
    const normalizedKeywordWeight = totalWeight > 0 ? keywordWeight / totalWeight : 0;
    const normalizedSemanticWeight = totalWeight > 0 ? semanticWeight / totalWeight : 1;

    const queryId = generateRequestId();

    logger.info('A-1: hybrid retrieval weights', {
      context: {
        queryId,
        queryType: policy.queryType ?? null,
        keywordWeight,
        semanticWeight,
        matched: queryWeights.matched,
        sessionId: policy.sessionId ?? null,
        timestamp: new Date().toISOString(),
      },
    });

    // 3. Obter embeddings do query
    const embeddingStart = performance.now();
    const queryEmbedding = await embeddingsManager.generateEmbedding({
      text: query,
    });
    const embeddingMs = performance.now() - embeddingStart;

    // 4. Executar a busca de similaridade (pgvector ou fallback em JS)
    const useNative = await vectorSearchService.isNativeAvailable();
    let matches: Array<{ chunkId: string; similarity: number }> = [];

    if (useNative) {
      const vectorMatches = await vectorSearchService.search(
        queryEmbedding,
        source,
        fetchK,
        minSimilarity,
        {
          repoFullName: policy.scope?.repoFullName,
          includeGlobal: policy.scope?.includeGlobal,
          freshnessDays: policy.freshnessDays,
        },
      );
      matches = vectorMatches.map((m) => ({
        chunkId: m.chunkId,
        similarity: m.similarity,
      }));
    } else {
      matches = await this.retrieveFallback(queryEmbedding, policy, fetchK, minSimilarity);
    }

    // Spec 10259 T6: busca lexical (keyword) simples por LIKE sobre os termos
    // da query. Limita a fetchK*3 candidatos para performance em SQLite.
    const keywordMatches =
      normalizedKeywordWeight > 0 ? await this.retrieveKeyword(query, policy, fetchK * 3) : [];

    // Merge e normalização dos scores de forma a somar os pesos configuráveis.
    const mergedScores = this.mergeHybridScores(
      matches,
      keywordMatches,
      normalizedSemanticWeight,
      normalizedKeywordWeight,
      fetchK,
    );
    matches = mergedScores;

    if (matches.length === 0) {
      // B-2: log estruturado mesmo em miss
      const retrievalMs = performance.now() - retrievalStart;
      logger.info('RAG retrieval completed', {
        context: {
          query: query.slice(0, 100),
          source,
          resultCount: 0,
          embeddingMs,
          retrievalMs,
          latencyMs: embeddingMs + retrievalMs,
          topScores: [],
          avgChunkTokens: 0,
        },
      });
      return [];
    }

    // Avaliação de RAG (2026-07-26, B-1): RAGFeedbackService existia pronto e
    // testado, mas nada em produção chamava recordImplicitFeedback/
    // recordFeedback — zero sinal real sendo coletado. Este é o ponto vivo
    // único de retrieval semântico; começa a alimentar o loop de feedback
    // (chunk foi mostrado = sinal implícito positivo). Fire-and-forget:
    // nunca deve atrasar ou derrubar a resposta de retrieval.
    ragFeedbackService.recordImplicitFeedback(
      generateRequestId(),
      query,
      matches.map((m) => m.chunkId),
      source,
    );

    // 5. Hydration: Carregar os conteúdos originais e aplicar os filtros específicos
    let results = await this.hydrateMatches(matches, policy);

    // 6. Reordenação por LLM via OpenRouter, quando configurada
    if (needsRerank && results.length > 0) {
      try {
        const rerankInputs = results.map((r) => ({
          content: r.content,
          source: r.id,
          artigo_ou_secao: r.sectionHeader || r.docType,
          score: r.score,
        }));

        const reranked = await llmReorderService.rerank(query, rerankInputs, {
          topK,
          demandId: policy.demandId,
          agentName: policy.agentName,
        });

        // Remapar de volta ao resultado estruturado mantendo os metadados
        const rerankedMap = new Map(reranked.results.map((item) => [item.source, item]));
        results = results
          .map((res) => {
            const item = rerankedMap.get(res.id);
            if (item) {
              return { ...res, score: item.rerankScore };
            }
            return null;
          })
          .filter((res): res is UnifiedRetrievalResult => res !== null)
          .sort((a, b) => b.score - a.score);
      } catch (err) {
        logger.warn('LLM reorder failed, falling back to original retrieval scores', {
          error: err instanceof Error ? err : undefined,
        });
      }
    }

    // B-2: log estruturado de performance do retrieval
    const finalResults = results.slice(0, topK);
    const retrievalMs = performance.now() - retrievalStart;
    const topScores = finalResults.map((r) => r.score);
    const avgChunkTokens =
      finalResults.length > 0
        ? finalResults.reduce((sum, r) => sum + r.content.length, 0) / 4 / finalResults.length
        : 0;

    logger.info('RAG retrieval completed', {
      context: {
        query: query.slice(0, 100),
        source,
        resultCount: finalResults.length,
        embeddingMs,
        retrievalMs,
        latencyMs: embeddingMs + retrievalMs,
        topScores,
        avgChunkTokens,
      },
    });

    return finalResults;
  }

  /**
   * Spec 10259 T6: busca lexical simples via LIKE com os termos da query.
   * Retorna até `limit` candidatos com um score de 0 a 1 baseado na
   * cobertura de termos no conteúdo.
   */
  private async retrieveKeyword(
    query: string,
    policy: RetrievalPolicy,
    limit: number,
  ): Promise<Array<{ chunkId: string; keywordScore: number }>> {
    const normalizedQuery = query
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    const terms = normalizedQuery
      .split(/\s+/)
      .filter((t) => t.length > 2)
      .filter((t, i, arr) => arr.indexOf(t) === i);
    if (terms.length === 0) {
      return [];
    }

    const conditions: SQL<unknown>[] = [];
    for (const term of terms) {
      conditions.push(sql`LOWER(content) LIKE ${`%${term}%`}`);
    }

    let querySql = sql`
      SELECT id, content
      FROM refinement_rag_documents
      WHERE ${sql.join(conditions, sql` OR `)}
    `;
    if (policy.freshnessDays && policy.freshnessDays > 0) {
      const cutoff = Date.now() - policy.freshnessDays * 24 * 60 * 60 * 1000;
      querySql = sql`
        SELECT id, content
        FROM refinement_rag_documents
        WHERE (${sql.join(conditions, sql` OR `)}) AND updated_at >= ${cutoff}
      `;
    }

    const rawRows =
      ((await dbAll(this.database, querySql)) as Array<
        | {
            id: string;
            content: string;
          }
        | undefined
      >) ?? [];
    const rows = rawRows.filter((r): r is { id: string; content: string } => r != null);

    const results: Array<{ chunkId: string; keywordScore: number }> = [];
    for (const row of rows) {
      const normalizedContent = row.content
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      let matched = 0;
      let totalMatches = 0;
      for (const term of terms) {
        const count = (
          normalizedContent.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ||
          []
        ).length;
        if (count > 0) {
          matched++;
          totalMatches += count;
        }
      }
      if (matched === 0) continue;
      const coverage = matched / terms.length;
      const density = Math.min(1, totalMatches / (terms.length * 3));
      const score = coverage * 0.7 + density * 0.3;
      results.push({ chunkId: row.id, keywordScore: Math.min(1, Math.max(0, score)) });
    }

    return results.sort((a, b) => b.keywordScore - a.keywordScore).slice(0, limit);
  }

  /**
   * Spec 10259 T6: combina scores semânticos e lexicais com os pesos configuráveis.
   */
  private mergeHybridScores(
    semanticMatches: Array<{ chunkId: string; similarity: number }>,
    keywordMatches: Array<{ chunkId: string; keywordScore: number }>,
    semanticWeight: number,
    keywordWeight: number,
    topK: number,
  ): Array<{ chunkId: string; similarity: number }> {
    const merged = new Map<string, number>();
    for (const m of semanticMatches) {
      merged.set(m.chunkId, (merged.get(m.chunkId) ?? 0) + m.similarity * semanticWeight);
    }
    for (const m of keywordMatches) {
      merged.set(m.chunkId, (merged.get(m.chunkId) ?? 0) + m.keywordScore * keywordWeight);
    }
    return Array.from(merged.entries())
      .map(([chunkId, similarity]) => ({ chunkId, similarity }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  /**
   * Fallback de similaridade em NodeJS para SQLite (carrega filtrado por data para otimização)
   */
  private async retrieveFallback(
    queryEmbedding: number[],
    policy: RetrievalPolicy,
    fetchK: number,
    minSimilarity: number,
  ): Promise<Array<{ chunkId: string; similarity: number }>> {
    // Otimização: Aplicar filtros temporais prévios na query SQL para evitar brute-force
    let querySql = sql`SELECT id, embedding FROM refinement_rag_documents WHERE embedding IS NOT NULL`;
    if (policy.freshnessDays && policy.freshnessDays > 0) {
      const cutoff = Date.now() - policy.freshnessDays * 24 * 60 * 60 * 1000;
      querySql = sql`SELECT id, embedding FROM refinement_rag_documents WHERE embedding IS NOT NULL AND updated_at >= ${cutoff}`;
    }
    const rows = (await dbAll(this.database, querySql)) as Array<{
      id: string;
      embedding: string | null;
    }>;

    const matches: Array<{ chunkId: string; similarity: number }> = [];

    for (const row of rows) {
      if (!row.embedding) continue;
      try {
        const docEmbedding = embeddingService.deserializeEmbedding(row.embedding);
        const similarity = embeddingService.cosineSimilarity(queryEmbedding, docEmbedding);
        if (similarity >= minSimilarity) {
          matches.push({ chunkId: row.id, similarity });
        }
      } catch (_) {
        // Ignora embeddings corrompidos
      }
    }

    return matches.sort((a, b) => b.similarity - a.similarity).slice(0, fetchK);
  }

  /**
   * Hydrates database matching IDs to complete structured docs and applies scope filters
   */
  private async hydrateMatches(
    matches: Array<{ chunkId: string; similarity: number }>,
    policy: RetrievalPolicy,
  ): Promise<UnifiedRetrievalResult[]> {
    const ids = matches.map((m) => m.chunkId);
    const scoreMap = new Map(matches.map((m) => [m.chunkId, m.similarity]));

    if (ids.length === 0) return [];

    const rows = (await dbAll(
      this.database,
      sql`
        SELECT id, source_key, doc_type, demand_id, content, repo_full_name, updated_at
        FROM refinement_rag_documents
        WHERE id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
      `,
    )) as Array<{
      id: string;
      source_key: string;
      doc_type: string;
      demand_id: number | null;
      content: string;
      repo_full_name: string | null;
      updated_at: number;
    }>;

    // Aplicar filtros e escopos (filtro de repositórios e atualidade)
    const repoFullName = policy.scope?.repoFullName?.trim() || null;
    const includeGlobal = policy.scope?.includeGlobal === true;
    const freshnessCutoff = policy.freshnessDays
      ? Date.now() - policy.freshnessDays * 24 * 60 * 60 * 1000
      : 0;

    return rows
      .filter((row) => {
        // Filtro de frescor temporal (updated_at)
        if (freshnessCutoff > 0 && row.updated_at < freshnessCutoff) return false;

        // Filtro Repo Lock
        if (repoFullName) {
          return (
            row.repo_full_name === repoFullName || (includeGlobal && row.repo_full_name === null)
          );
        } else {
          return includeGlobal || row.repo_full_name === null;
        }
      })
      .map((row) => ({
        id: row.id,
        sourceKey: row.source_key,
        docType: row.doc_type,
        content: row.content,
        repoFullName: row.repo_full_name,
        score: scoreMap.get(row.id) ?? 0,
        metadata: { demandId: row.demand_id, updatedAt: row.updated_at },
      }))
      .sort((a, b) => b.score - a.score);
  }
}

export const retrievalService = new RetrievalService();
