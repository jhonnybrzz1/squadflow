import { createHash } from 'crypto';
import { logger } from '../utils/logger';
import { rerankTelemetryService, type RerankTelemetryEvent } from './rerank-telemetry';
import { rerankEffectiveTotal, rerankFailureTotal } from '../metrics';

/**
 * Rerank Service (Cohere cross-encoder via OpenRouter)
 *
 * Calls OpenRouter's dedicated /api/v1/rerank endpoint with a Cohere rerank
 * model. This produces relevance scores directly instead of asking a chat
 * model to generate document indices.
 *
 * Provides: feature toggle, fallback, A/B testing, cost tracking, and bypass logic.
 *
 * PRD rules:
 * - If OpenRouter fails or timeout > 5s, fallback to original retrieval
 * - Bypass for short queries (< 10 tokens) without retrieval keywords
 * - Cost per rerank request must not exceed $0.10
 */

const RERANK_MODEL = process.env.RERANK_MODEL || 'cohere/rerank-v3.5';
const RERANK_TIMEOUT_MS = parseInt(process.env.RERANK_TIMEOUT_MS || '5000', 10);
// Incidente 2026-07-17 (rerank infra): 25 docs × queries de 21k tokens
// dominaram o gasto. 15 docs preserva a qualidade do top-K típico (≤5).
const RERANK_MAX_DOCS = parseInt(process.env.RERANK_MAX_DOCS || '15', 10);
// cohere/rerank-v3.5 via OpenRouter: US$2.00/1k searches = US$0.002 por search unit.
// O default anterior (0.001) subcontabilizava o gasto real em ~2×.
const RERANK_COST_PER_SEARCH_USD = Number(process.env.RERANK_COST_PER_SEARCH_USD || '0.002');
// Cohere cobra search units proporcionais ao tamanho da query — descrições de
// infra com logs/dumps chegavam a 21k tokens. ~2000 chars ≈ 500 tokens cobrem
// título + abertura da descrição sem pagar pelo dump inteiro.
const RERANK_MAX_QUERY_CHARS = parseInt(process.env.RERANK_MAX_QUERY_CHARS || '2000', 10);
// Cache curto: reprocessamentos/retries da MESMA query+docs não pagam de novo.
const RERANK_CACHE_TTL_MS = parseInt(process.env.RERANK_CACHE_TTL_MS || '600000', 10);
const RERANK_CACHE_MAX_ENTRIES = 50;

interface OpenRouterRerankResponse {
  results?: Array<{
    index: number;
    relevance_score: number;
  }>;
  usage?: {
    search_units?: number;
  };
}

/** Keywords that indicate a query needs retrieval/reranking */
const RETRIEVAL_KEYWORDS = [
  'circular',
  'resolução',
  'normativ',
  'regulament',
  'compliance',
  'contrato',
  'prazo',
  'documento',
  'norma',
];

export interface RerankResult {
  content: string;
  source: string;
  artigo_ou_secao: string;
  originalScore: number;
  rerankScore: number;
  index: number;
  /** Spec 10139: score de diversidade 0-1 (penaliza fontes repetidas). */
  diversityScore?: number;
  /** Spec 10139: score de saliência 0-1 (marcadores críticos no conteúdo). */
  salienceScore?: number;
  /** Spec 10139: score final combinando relevância + diversidade + saliência. */
  finalScore?: number;
}

export interface RerankInput {
  content: string;
  source: string;
  artigo_ou_secao: string;
  score: number;
}

interface RerankCacheEntry {
  expiresAt: number;
  value: {
    results: RerankResult[];
    fallbackUsed: boolean;
    rerankLatencyMs: number;
    rerankCostUsd: number;
    provider: 'openrouter' | 'none';
  };
}

// ============================================================
// Spec 10139: Re-ranqueamento tridimensional (Relevância + Diversidade + Saliência)
// ============================================================

/**
 * Marcadores críticos reutilizados de context-engineering.ts (selectSalientInsights).
 * Duplicado aqui para evitar dependência circular e permitir teste isolado.
 */
const SALIENT_MARKERS =
  /(decis[aã]o|recomenda[cç][aã]o|risco|diverg[êe]ncia|prioridade|bloqueio|evid[êe]ncia)/i;

/**
 * Spec 10139 T1: computa score de diversidade 0-1 por chunk.
 * Penaliza chunks cuja `source` já apareceu em chunks anteriores no ranking.
 * Primeiro chunk sempre recebe diversity=1 (sem anterior para comparar).
 */
export function computeDiversityScore(results: RerankResult[]): number[] {
  const seenSources = new Set<string>();
  return results.map((r) => {
    if (seenSources.has(r.source)) {
      return 0.3; // mesma fonte já vista — penaliza mas não zera
    }
    seenSources.add(r.source);
    return 1.0;
  });
}

/**
 * Spec 10139 T2: computa score de saliência 0-1 por chunk.
 * 1.0 se o conteúdo contém marcador crítico, 0 caso contrário.
 */
export function computeSalienceScore(results: RerankResult[]): number[] {
  return results.map((r) => (SALIENT_MARKERS.test(r.content) ? 1.0 : 0.0));
}

/** Pesos configuráveis via env para o score tridimensional. */
export type TridimensionalWeights = {
  relevance: number;
  diversity: number;
  salience: number;
};

/** Spec 10139 T3: lê pesos do env com defaults 0.7/0.15/0.15 e normaliza. */
export function getTridimensionalWeights(): TridimensionalWeights {
  const relevance = Number(process.env.RERANK_RELEVANCE_WEIGHT ?? 0.7);
  const diversity = Number(process.env.RERANK_DIVERSITY_WEIGHT ?? 0.15);
  const salience = Number(process.env.RERANK_SALIENCE_WEIGHT ?? 0.15);
  const sum = relevance + diversity + salience;
  if (sum <= 0) return { relevance: 1, diversity: 0, salience: 0 };
  return {
    relevance: relevance / sum,
    diversity: diversity / sum,
    salience: salience / sum,
  };
}

/**
 * Spec 10139 T3: combina os três scores em um score final 0-1.
 * Se diversityWeight=0 e salienceWeight=0, finalScore = relevance (backward compat).
 */
export function combineScores(
  relevance: number[],
  diversity: number[],
  salience: number[],
  weights: TridimensionalWeights,
): number[] {
  return relevance.map((rel, i) => {
    const div = diversity[i] ?? 0;
    const sal = salience[i] ?? 0;
    return rel * weights.relevance + div * weights.diversity + sal * weights.salience;
  });
}

/**
 * Spec 10139 T4: aplica pós-processamento tridimensional aos results do rerank.
 * Re-ordena por finalScore (desc), preservando os campos opcionais em cada result.
 */
export function applyTridimensionalRerank(results: RerankResult[]): RerankResult[] {
  const weights = getTridimensionalWeights();
  const diversity = computeDiversityScore(results);
  const salience = computeSalienceScore(results);
  const relevance = results.map((r) => r.rerankScore);
  const finalScores = combineScores(relevance, diversity, salience, weights);

  const enriched = results.map((r, i) => ({
    ...r,
    diversityScore: diversity[i],
    salienceScore: salience[i],
    finalScore: finalScores[i],
  }));

  // Re-ordena por finalScore (desc), com desempate por rerankScore (desc).
  return enriched.sort(
    (a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0) || b.rerankScore - a.rerankScore,
  );
}

export class LlmReorderService {
  private apiKey: string | null = null;
  // Incidente 2026-07-17: orquestrações reiniciadas em loop pagaram o mesmo
  // rerank centenas de vezes. Cache TTL por (query, topK, conjunto de docs).
  private readonly resultCache = new Map<string, RerankCacheEntry>();

  constructor() {
    this.initializeClient();
  }

  /**
   * Auditoria 2026-07-21: a assinatura usava só `doc.source` (id do chunk),
   * não o conteúdo — se o mesmo id fosse reingerido com texto diferente
   * dentro do TTL do cache (10min default), um hit serviria um rerankScore
   * calculado sobre o texto antigo. O caller (retrieval-service.ts) sempre
   * reanexa o `content` fresco por id, então isso nunca vazava texto obsoleto
   * pro usuário — só podia distorcer a ordenação/score por até TTL. Incluir
   * um hash do conteúdo fecha essa lacuna sem custo extra (RERANK_MODEL é
   * uma constante de módulo, não varia dentro do processo — não precisa
   * entrar na chave).
   */
  private cacheKey(queryHash: string, topK: number, documents: RerankInput[]): string {
    const docsSignature = documents
      .slice(0, RERANK_MAX_DOCS)
      .map((doc) => `${doc.source}:${this.hashContent(doc.content)}`)
      .join('|');
    return `${queryHash}:${topK}:${docsSignature}`;
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 12);
  }

  private getCached(key: string): RerankCacheEntry['value'] | null {
    const entry = this.resultCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.resultCache.delete(key);
      return null;
    }
    return entry.value;
  }

  private setCached(key: string, value: RerankCacheEntry['value']): void {
    if (this.resultCache.size >= RERANK_CACHE_MAX_ENTRIES) {
      const oldest = this.resultCache.keys().next().value;
      if (oldest !== undefined) this.resultCache.delete(oldest);
    }
    this.resultCache.set(key, { expiresAt: Date.now() + RERANK_CACHE_TTL_MS, value });
  }

  /** Reset interno (testes). */
  clearResultCache(): void {
    this.resultCache.clear();
  }

  private initializeClient(): void {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (apiKey) {
      this.apiKey = apiKey;
      logger.info('Cohere rerank initialized via OpenRouter', {
        context: { model: RERANK_MODEL, endpoint: '/api/v1/rerank' },
      });
    } else {
      logger.warn('OPENROUTER_API_KEY not set. Rerank will use fallback (original scores).');
    }
  }

  /**
   * Check if rerank is enabled and available.
   */
  isAvailable(): boolean {
    return this.apiKey !== null && process.env.RERANK_ENABLED === 'true';
  }

  /**
   * Check if a query should bypass reranking (too short or no retrieval keywords).
   * PRD rule: queries < 10 tokens without retrieval keywords skip rerank.
   */
  shouldBypass(query: string): boolean {
    const tokens = query.trim().split(/\s+/);
    if (tokens.length < 10) {
      const queryLower = query.toLowerCase();
      const hasRetrievalKeyword = RETRIEVAL_KEYWORDS.some((kw) =>
        new RegExp(kw, 'i').test(queryLower),
      );
      if (!hasRetrievalKeyword) {
        return true;
      }
    }
    return false;
  }

  /**
   * Rerank documents using OpenRouter LLM.
   * Returns reranked documents with scores, or falls back to original order on error.
   */
  async rerank(
    query: string,
    documents: RerankInput[],
    options: {
      topK?: number;
      demandId?: number;
      agentName?: string;
    } = {},
  ): Promise<{
    results: RerankResult[];
    fallbackUsed: boolean;
    rerankLatencyMs: number;
    rerankCostUsd: number;
    provider: 'openrouter' | 'none';
  }> {
    // Query compacta: título + abertura da descrição bastam para relevância;
    // dumps/logs além do teto só inflavam search units (incidente 2026-07-17).
    if (query.length > RERANK_MAX_QUERY_CHARS) {
      query = query.slice(0, RERANK_MAX_QUERY_CHARS);
    }

    const topK = Math.min(options.topK || 5, documents.length);
    const agentName = options.agentName || 'documental';
    const queryHash = rerankTelemetryService.hashQuery(query);
    const queryTokenCount = query.trim().split(/\s+/).length;

    // Check A/B group
    const abGroup = rerankTelemetryService.assignABGroup(queryHash);

    // Pre-rerank metrics
    const scores = documents.map((d) => d.score);
    const topScoreBefore = Math.max(...scores, 0);
    const avgScoreBefore =
      scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

    const totalStartTime = Date.now();

    // Bypass check
    if (this.shouldBypass(query)) {
      const results = documents.slice(0, topK).map((doc, i) => ({
        content: doc.content,
        source: doc.source,
        artigo_ou_secao: doc.artigo_ou_secao,
        originalScore: doc.score,
        rerankScore: doc.score,
        index: i,
      }));

      this.recordTelemetry({
        queryHash,
        demandId: options.demandId,
        agentName,
        abGroup,
        numDocsRetrieved: documents.length,
        numDocsAfterRerank: topK,
        topKRequested: topK,
        retrievalLatencyMs: 0,
        rerankLatencyMs: 0,
        totalLatencyMs: Date.now() - totalStartTime,
        estimatedCostUsd: 0,
        rerankCostUsd: 0,
        topScoreBefore,
        topScoreAfter: topScoreBefore,
        avgScoreBefore,
        avgScoreAfter: avgScoreBefore,
        fallbackUsed: false,
        fallbackReason: 'bypass_short_query',
        rerankProvider: 'none',
        queryTokenCount,
      });

      rerankEffectiveTotal.labels('none').inc();

      // Spec 10139 T4: aplica pós-processamento tridimensional mesmo no bypass
      // (diversidade e saliência são locais, sem custo externo).
      const tridimensionalResults = applyTridimensionalRerank(results);

      return {
        results: tridimensionalResults,
        fallbackUsed: false,
        rerankLatencyMs: 0,
        rerankCostUsd: 0,
        provider: 'none',
      };
    }

    // Control group: skip rerank
    if (abGroup === 'control') {
      const results = documents.slice(0, topK).map((doc, i) => ({
        content: doc.content,
        source: doc.source,
        artigo_ou_secao: doc.artigo_ou_secao,
        originalScore: doc.score,
        rerankScore: doc.score,
        index: i,
      }));

      this.recordTelemetry({
        queryHash,
        demandId: options.demandId,
        agentName,
        abGroup: 'control',
        numDocsRetrieved: documents.length,
        numDocsAfterRerank: topK,
        topKRequested: topK,
        retrievalLatencyMs: 0,
        rerankLatencyMs: 0,
        totalLatencyMs: Date.now() - totalStartTime,
        estimatedCostUsd: 0,
        rerankCostUsd: 0,
        topScoreBefore,
        topScoreAfter: topScoreBefore,
        avgScoreBefore,
        avgScoreAfter: avgScoreBefore,
        fallbackUsed: false,
        rerankProvider: 'none',
        queryTokenCount,
      });

      rerankEffectiveTotal.labels('none').inc();

      // Spec 10139 T4: aplica pós-processamento tridimensional no grupo de controle.
      const tridimensionalControlResults = applyTridimensionalRerank(results);

      return {
        results: tridimensionalControlResults,
        fallbackUsed: false,
        rerankLatencyMs: 0,
        rerankCostUsd: 0,
        provider: 'none',
      };
    }

    // Defesa em profundidade: rerank() também respeita o toggle, não apenas
    // o call-site via isAvailable(). Chamadas diretas (testes, scripts de
    // avaliação) não podem gastar dinheiro real com RERANK_ENABLED desligado.
    if (!this.isAvailable()) {
      return this.fallback(documents, topK, {
        queryHash,
        demandId: options.demandId,
        agentName,
        totalStartTime,
        topScoreBefore,
        avgScoreBefore,
        queryTokenCount,
        reason: 'rerank_disabled',
      });
    }

    // Cache curto: retries/reprocessamentos da mesma query+docs não pagam de novo.
    const cacheKey = this.cacheKey(queryHash, topK, documents);
    const cached = this.getCached(cacheKey);
    if (cached) {
      logger.debug('Rerank cache hit — chamada externa evitada', {
        context: { queryHash, topK, demandId: options.demandId },
      });
      return { ...cached, rerankCostUsd: 0, rerankLatencyMs: 0 };
    }

    // Rerank group: call OpenRouter
    if (!this.apiKey) {
      return this.fallback(documents, topK, {
        queryHash,
        demandId: options.demandId,
        agentName,
        totalStartTime,
        topScoreBefore,
        avgScoreBefore,
        queryTokenCount,
        reason: 'openrouter_client_unavailable',
      });
    }

    try {
      const rerankStartTime = Date.now();

      // Prepare documents for the dedicated cross-encoder endpoint.
      const docsToRerank = documents.slice(0, RERANK_MAX_DOCS);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch('https://openrouter.ai/api/v1/rerank', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:5000',
            'X-Title': process.env.OPENROUTER_APP_NAME || 'AiChatFlow',
          },
          body: JSON.stringify({
            model: RERANK_MODEL,
            query,
            documents: docsToRerank.map((doc) => doc.content),
            top_n: topK,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw new Error(`OpenRouter rerank failed: HTTP ${response.status}`);
      }

      const responseData = (await response.json()) as OpenRouterRerankResponse;
      const rankedItems = Array.isArray(responseData.results) ? responseData.results : [];

      const rerankLatencyMs = Date.now() - rerankStartTime;

      const validRankedItems = rankedItems
        .filter(
          (item) =>
            Number.isInteger(item.index) &&
            item.index >= 0 &&
            item.index < docsToRerank.length &&
            Number.isFinite(item.relevance_score),
        )
        .slice(0, topK);

      if (validRankedItems.length === 0) {
        return this.fallback(documents, topK, {
          queryHash,
          demandId: options.demandId,
          agentName,
          totalStartTime,
          topScoreBefore,
          avgScoreBefore,
          queryTokenCount,
          reason: 'rerank_parse_failed',
        });
      }

      const searchUnits = responseData.usage?.search_units ?? 1;
      const rerankCostUsd = searchUnits * RERANK_COST_PER_SEARCH_USD;

      const results: RerankResult[] = validRankedItems.map((item) => {
        const originalDoc = docsToRerank[item.index];
        return {
          content: originalDoc.content,
          source: originalDoc.source,
          artigo_ou_secao: originalDoc.artigo_ou_secao,
          originalScore: originalDoc.score,
          rerankScore: item.relevance_score,
          index: item.index,
        };
      });

      // Post-rerank metrics
      const postScores = results.map((r) => r.rerankScore);
      const topScoreAfter = Math.max(...postScores, 0);
      const avgScoreAfter =
        postScores.length > 0 ? postScores.reduce((a, b) => a + b, 0) / postScores.length : 0;

      this.recordTelemetry({
        queryHash,
        demandId: options.demandId,
        agentName,
        abGroup: 'rerank',
        numDocsRetrieved: documents.length,
        numDocsAfterRerank: results.length,
        topKRequested: topK,
        retrievalLatencyMs: 0,
        rerankLatencyMs,
        totalLatencyMs: Date.now() - totalStartTime,
        estimatedCostUsd: 0,
        rerankCostUsd,
        topScoreBefore,
        topScoreAfter,
        avgScoreBefore,
        avgScoreAfter,
        fallbackUsed: false,
        rerankProvider: 'cohere-openrouter',
        queryTokenCount,
      });

      rerankEffectiveTotal.labels('cohere-openrouter').inc();

      // Spec 10139 T4: aplica pós-processamento tridimensional ao resultado do Cohere.
      const tridimensionalResults = applyTridimensionalRerank(results);

      const success = {
        results: tridimensionalResults,
        fallbackUsed: false,
        rerankLatencyMs,
        rerankCostUsd,
        provider: 'openrouter' as const,
      };
      // Apenas resultados reais entram no cache (fallbacks não).
      this.setCached(cacheKey, success);
      return success;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('OpenRouter rerank failed, using fallback', {
        error: error instanceof Error ? error : undefined,
        context: { queryHash, agentName },
      });

      // EMB-002: Don't increment rerankFailureTotal here — fallback() does
      // it. Incrementing in both places double-counts a single failure.

      return this.fallback(documents, topK, {
        queryHash,
        demandId: options.demandId,
        agentName,
        totalStartTime,
        topScoreBefore,
        avgScoreBefore,
        queryTokenCount,
        reason: `openrouter_error: ${errorMessage}`,
      });
    }
  }

  /**
   * Fallback: return documents in original order.
   */
  private fallback(
    documents: RerankInput[],
    topK: number,
    ctx: {
      queryHash: string;
      demandId?: number;
      agentName: string;
      totalStartTime: number;
      topScoreBefore: number;
      avgScoreBefore: number;
      queryTokenCount: number;
      reason: string;
    },
  ): {
    results: RerankResult[];
    fallbackUsed: boolean;
    rerankLatencyMs: number;
    rerankCostUsd: number;
    provider: 'none';
  } {
    const results = documents.slice(0, topK).map((doc, i) => ({
      content: doc.content,
      source: doc.source,
      artigo_ou_secao: doc.artigo_ou_secao,
      originalScore: doc.score,
      rerankScore: doc.score,
      index: i,
    }));

    this.recordTelemetry({
      queryHash: ctx.queryHash,
      demandId: ctx.demandId,
      agentName: ctx.agentName,
      abGroup: 'rerank',
      numDocsRetrieved: documents.length,
      numDocsAfterRerank: results.length,
      topKRequested: topK,
      retrievalLatencyMs: 0,
      rerankLatencyMs: 0,
      totalLatencyMs: Date.now() - ctx.totalStartTime,
      estimatedCostUsd: 0,
      rerankCostUsd: 0,
      topScoreBefore: ctx.topScoreBefore,
      topScoreAfter: ctx.topScoreBefore,
      avgScoreBefore: ctx.avgScoreBefore,
      avgScoreAfter: ctx.avgScoreBefore,
      fallbackUsed: true,
      fallbackReason: ctx.reason,
      rerankProvider: 'none',
      queryTokenCount: ctx.queryTokenCount,
    });

    rerankEffectiveTotal.labels('none').inc();
    rerankFailureTotal.inc();

    // Spec 10139 T4: aplica pós-processamento tridimensional mesmo no fallback
    // (diversidade e saliência são locais, sem custo externo).
    const tridimensionalFallbackResults = applyTridimensionalRerank(results);

    return {
      results: tridimensionalFallbackResults,
      fallbackUsed: true,
      rerankLatencyMs: 0,
      rerankCostUsd: 0,
      provider: 'none',
    };
  }

  /**
   * Fire-and-forget telemetry recording.
   */
  private recordTelemetry(event: RerankTelemetryEvent): void {
    rerankTelemetryService.recordEvent(event).catch((e) =>
      logger.warn('Failed to record rerank telemetry', {
        error: e instanceof Error ? e : undefined,
      }),
    );
  }
}

export const llmReorderService = new LlmReorderService();
