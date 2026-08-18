/**
 * Hybrid Demand Classifier
 *
 * Combines rule-based ambiguity scoring with embedding similarity
 * to reduce false-negatives on vague demands. Embedding is called
 * ONLY when the rule-based score falls in the ambiguous zone (30-70).
 *
 * PRD targets:
 * - Accuracy ≥ 85% on 100-demand labeled set
 * - Cost ≤ US$0.0005/demand (embedding only in ambiguous zone)
 * - Latency P95 ≤ 300ms
 * - Fallback to rules if embedding fails
 */

import { embeddingService } from './embedding-service';
import { logger } from '../utils/logger';
import { aiUsageTracker, estimateTextTokens, estimateCost } from './ai-usage-tracker';
import { generateRequestId } from '../utils/request-id';
import {
  demandsByClassificationZone,
  classificationLatency,
  classificationCostPerDemand,
} from '../metrics';

// ============================================
// Configuration
// ============================================

const AMBIGUOUS_ZONE_LOW = 30;
const AMBIGUOUS_ZONE_HIGH = 70;
const EMBEDDING_CONFIDENCE_THRESHOLD = 0.6;
const EMBEDDING_TIMEOUT_MS = 5_000;

export type VaguenessLabel = 'vaga' | 'nao_vaga';
export type ClassificationMethod = 'rule' | 'hybrid' | 'fallback';

export interface HybridClassificationResult {
  label: VaguenessLabel;
  ruleScore: number; // 0-100 ambiguity score from rules
  embeddingScore: number | null; // cosine similarity (0-1) or null if not used
  method: ClassificationMethod;
  confidence: number; // 0-1
  latencyMs: number;
  costUsd: number;
}

// ============================================
// Reference examples for embedding comparison
// Manually curated vague/not-vague anchors.
// ============================================

const VAGUE_EXEMPLARS: string[] = [
  'Melhorar o sistema para ficar melhor',
  'Talvez seja útil ter alguns filtros. Não sei exatamente quais.',
  'Precisamos fazer algo com os relatórios. Várias pessoas comentaram.',
  'O sistema está lento. Precisa melhorar a performance em geral.',
  'Seria interessante ter notificações no sistema. Pode ser por email ou dentro do sistema.',
];

const NOT_VAGUE_EXEMPLARS: string[] = [
  'Implementar cursor-based pagination no GET /api/demands retornando 20 itens por página com campos next_cursor e has_more.',
  'Corrigir erro 500 no endpoint POST /api/demands quando campo priority é null. Stack trace aponta para validação no middleware de schema.',
  'Adicionar campo select Prioridade com opções baixa, média, alta, crítica. Campo obrigatório, default média. Exibir como badge colorido na listagem.',
  'Criar GET /api/demands/export/csv com filtros por data_inicio, data_fim e status. Limitar a 10000 registros.',
  'Configurar Sentry v8 no Express middleware. DSN via env. Capturar uncaught exceptions e 5xx. Sample rate 0.1 em prod.',
];

// ============================================
// Vague-word scoring (rule-based)
// ============================================

const VAGUE_WORDS_PT: Array<{ word: string; weight: number }> = [
  // High-signal vague markers (conditional/uncertain)
  { word: 'talvez', weight: 12 },
  { word: 'pode ser', weight: 12 },
  { word: 'seria bom', weight: 12 },
  { word: 'seria legal', weight: 12 },
  { word: 'seria interessante', weight: 12 },
  { word: 'não sei', weight: 14 },
  { word: 'acho que', weight: 10 },
  { word: 'depende', weight: 10 },
  { word: 'eventualmente', weight: 10 },
  { word: 'poderia', weight: 10 },
  { word: 'possível', weight: 8 },
  { word: 'poderíamos', weight: 10 },
  { word: 'podíamos', weight: 10 },
  { word: 'será que', weight: 10 },
  { word: 'pensar em', weight: 10 },
  // Medium-signal vague indicators
  { word: 'algumas coisas', weight: 10 },
  { word: 'algo sobre', weight: 10 },
  { word: 'coisa do', weight: 8 },
  { word: 'coisa de', weight: 8 },
  { word: 'algum ', weight: 6 },
  { word: 'algumas', weight: 6 },
  { word: 'vários', weight: 6 },
  { word: 'diferentes', weight: 6 },
  { word: 'algo', weight: 6 },
  { word: 'coisa', weight: 5 },
  { word: 'coisas', weight: 6 },
  // Weak vagueness markers
  { word: 'rever', weight: 5 },
  { word: 'olhar', weight: 5 },
  { word: 'melhorar', weight: 4 },
  { word: 'melhor', weight: 3 },
  { word: 'otimizar', weight: 3 },
  // Hedging / uncertainty
  { word: 'precisa investigar', weight: 8 },
  { word: 'precisa analisar', weight: 8 },
  { word: 'precisa resolver', weight: 5 },
  { word: 'não está funcionando direito', weight: 10 },
  { word: 'às vezes', weight: 8 },
  { word: 'em geral', weight: 8 },
  { word: 'mais ou menos', weight: 8 },
  { word: 'tipo quando', weight: 8 },
  { word: 'ou algo assim', weight: 8 },
];

const VAGUE_WORDS_EN: Array<{ word: string; weight: number }> = [
  { word: 'maybe', weight: 10 },
  { word: 'possibly', weight: 10 },
  { word: 'could', weight: 6 },
  { word: 'might', weight: 8 },
  { word: 'perhaps', weight: 10 },
  { word: 'some', weight: 4 },
  { word: 'various', weight: 6 },
  { word: 'different', weight: 4 },
  { word: 'several', weight: 4 },
  { word: 'many', weight: 4 },
  { word: 'something', weight: 6 },
  { word: 'things', weight: 5 },
  { word: 'stuff', weight: 6 },
  { word: 'better', weight: 3 },
  { word: 'improve', weight: 3 },
];

const SPECIFICITY_SIGNALS = [
  // Technical specifics
  /\b(endpoint|api|get|post|put|delete|patch)\b/i,
  /\b(tabela|table|campo|field|coluna|column)\b/i,
  /\b(sql|query|migration|schema)\b/i,
  /\b(timeout|retry|ttl|cache)\b/i,
  // Quantitative signals
  /\d+\s*(ms|s|min|h|dias?|days?|req|rps|gb|mb|kb|%|px)/i,
  /\b(p50|p95|p99|sla|slo|rpo|rto)\b/i,
  // Structured requirements
  /\b(quando|when|se|if|então|then|caso|entao)\b.*\b(deve|must|should|retorn|return)\b/i,
  /\b(passo|step|etapa)\s*\d/i,
  // Specific tools/libs
  /\b(react|vue|express|postgres|redis|docker|k8s|terraform|sentry|grafana|playwright|vitest)\b/i,
];

/**
 * Compute a rule-based vagueness score (0-100).
 * Higher = more vague.
 */
export function computeRuleBasedScore(text: string): number {
  const lower = text.toLowerCase();
  let score = 0;

  // Vague word hits (weighted)
  for (const { word, weight } of VAGUE_WORDS_PT) {
    if (lower.includes(word)) score += weight;
  }
  for (const { word, weight } of VAGUE_WORDS_EN) {
    if (lower.includes(word)) score += weight;
  }

  // Short description penalty
  if (text.length < 80) score += 15;
  else if (text.length < 150) score += 8;

  // Question marks indicate uncertainty
  const qCount = (text.match(/\?/g) || []).length;
  score += qCount * 4;

  // Specificity signals reduce score
  for (const pattern of SPECIFICITY_SIGNALS) {
    if (pattern.test(text)) score -= 8;
  }

  // Long, detailed text is less likely to be vague
  if (text.length > 300) score -= 10;
  if (text.length > 600) score -= 10;

  // Numbered steps indicate structure
  const numberedSteps = (text.match(/\d+\)\s|\d+\.\s/g) || []).length;
  if (numberedSteps >= 2) score -= 12;

  // Lack of concrete outcome or action verb
  const hasConcreteAction =
    /\b(implementar|criar|adicionar|configurar|migrar|corrigir|fix|instalar|integrar|extrair|mover|remover|refatorar|atualizar)\b/i.test(
      text,
    );
  if (!hasConcreteAction && text.length < 300) score += 8;

  return Math.min(100, Math.max(0, score));
}

// ============================================
// Embedding classification
// ============================================

let exemplarEmbeddingsCache: { vague: number[][]; notVague: number[][] } | null = null;

async function getExemplarEmbeddings(): Promise<{ vague: number[][]; notVague: number[][] }> {
  if (exemplarEmbeddingsCache) return exemplarEmbeddingsCache;

  const [vagueEmbeddings, notVagueEmbeddings] = await Promise.all([
    embeddingService.getEmbeddings(VAGUE_EXEMPLARS),
    embeddingService.getEmbeddings(NOT_VAGUE_EXEMPLARS),
  ]);

  exemplarEmbeddingsCache = { vague: vagueEmbeddings, notVague: notVagueEmbeddings };
  return exemplarEmbeddingsCache;
}

/**
 * Classify text using embedding similarity against exemplars.
 * Returns a score 0-1 where > 0.5 means "vaga".
 */
async function classifyWithEmbedding(text: string): Promise<number> {
  const [inputEmbedding, exemplars] = await Promise.all([
    embeddingService.getEmbedding(text),
    getExemplarEmbeddings(),
  ]);

  // Average cosine similarity to vague exemplars
  const vagueSims = exemplars.vague.map((e) =>
    embeddingService.cosineSimilarity(inputEmbedding, e),
  );
  const avgVagueSim = vagueSims.reduce((a, b) => a + b, 0) / vagueSims.length;

  // Average cosine similarity to not-vague exemplars
  const notVagueSims = exemplars.notVague.map((e) =>
    embeddingService.cosineSimilarity(inputEmbedding, e),
  );
  const avgNotVagueSim = notVagueSims.reduce((a, b) => a + b, 0) / notVagueSims.length;

  // Normalized score: 0 = clearly not vague, 1 = clearly vague
  const total = avgVagueSim + avgNotVagueSim;
  if (total === 0) return 0.5;
  return avgVagueSim / total;
}

// ============================================
// Prometheus metrics helper
// ============================================

function emitMetrics(result: HybridClassificationResult): void {
  const zone =
    result.ruleScore > AMBIGUOUS_ZONE_HIGH
      ? 'clear_vague'
      : result.ruleScore < AMBIGUOUS_ZONE_LOW
        ? 'clear_not_vague'
        : 'ambiguous';

  demandsByClassificationZone.labels(zone, result.method, result.label).inc();
  classificationLatency.labels(result.method).observe(result.latencyMs / 1000);
  classificationCostPerDemand.labels(result.method).observe(result.costUsd);
}

// ============================================
// Hybrid classifier (public API)
// ============================================

/**
 * Classify a demand text as vaga/nao_vaga using hybrid approach.
 *
 * 1. Compute rule-based score (0-100).
 * 2. If score is in ambiguous zone (30-70), use embedding for final decision.
 * 3. Fallback to rules if embedding fails.
 */
export async function classifyDemandVagueness(
  title: string,
  description: string,
): Promise<HybridClassificationResult> {
  const startedAt = Date.now();
  const requestId = generateRequestId();
  const combinedText = `${title} ${description}`;
  const ruleScore = computeRuleBasedScore(combinedText);

  const isAmbiguous = ruleScore >= AMBIGUOUS_ZONE_LOW && ruleScore <= AMBIGUOUS_ZONE_HIGH;

  // Clear zone — use rules only
  if (!isAmbiguous) {
    const label: VaguenessLabel = ruleScore > AMBIGUOUS_ZONE_HIGH ? 'vaga' : 'nao_vaga';
    const confidence =
      ruleScore > AMBIGUOUS_ZONE_HIGH
        ? Math.min(1, (ruleScore - AMBIGUOUS_ZONE_HIGH) / 30 + 0.7)
        : Math.min(1, (AMBIGUOUS_ZONE_LOW - ruleScore) / 30 + 0.7);

    const latencyMs = Date.now() - startedAt;

    // Record zero-cost classification
    aiUsageTracker.record({
      timestamp: new Date().toISOString(),
      operation: 'classification:vagueness:rule',
      model: 'rule-based',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      cacheHit: false,
      estimatedTokensSaved: 0,
      estimatedCostSavedUsd: null,
      latencyMs,
      requestId,
      routingMode: 'unknown',
      routingReason: null,
      cacheKeyVersion: null,
      fallbackUsed: false,
    });

    const result: HybridClassificationResult = {
      label,
      ruleScore,
      embeddingScore: null,
      method: 'rule',
      confidence,
      latencyMs,
      costUsd: 0,
    };
    emitMetrics(result);
    return result;
  }

  // Ambiguous zone — try embedding
  try {
    const embeddingPromise = classifyWithEmbedding(combinedText);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Embedding timeout')), EMBEDDING_TIMEOUT_MS),
    );

    const embeddingScore = await Promise.race([embeddingPromise, timeoutPromise]);

    const label: VaguenessLabel = embeddingScore >= 0.5 ? 'vaga' : 'nao_vaga';
    const confidence =
      embeddingScore >= EMBEDDING_CONFIDENCE_THRESHOLD
        ? embeddingScore
        : embeddingScore <= 1 - EMBEDDING_CONFIDENCE_THRESHOLD
          ? 1 - embeddingScore
          : 0.5 + Math.abs(embeddingScore - 0.5);

    const latencyMs = Date.now() - startedAt;
    const estimatedTokens = estimateTextTokens(combinedText);
    const costEstimate = await estimateCost('text-embedding-3-small', estimatedTokens, 0);
    const costUsd = costEstimate.listCostUsd ?? 0;

    // Record embedding classification
    aiUsageTracker.record({
      timestamp: new Date().toISOString(),
      operation: 'classification:vagueness:hybrid',
      model: 'text-embedding-3-small',
      promptTokens: estimatedTokens,
      completionTokens: 0,
      totalTokens: estimatedTokens,
      estimatedCostUsd: costUsd,
      cacheHit: false,
      estimatedTokensSaved: 0,
      estimatedCostSavedUsd: null,
      latencyMs,
      requestId,
      routingMode: 'unknown',
      routingReason: null,
      cacheKeyVersion: null,
      fallbackUsed: false,
    });

    logger.info('Hybrid classification completed', {
      context: {
        requestId,
        ruleScore,
        embeddingScore,
        label,
        method: 'hybrid',
        latencyMs,
        costUsd,
      },
    });

    const hybridResult: HybridClassificationResult = {
      label,
      ruleScore,
      embeddingScore,
      method: 'hybrid',
      confidence,
      latencyMs,
      costUsd,
    };
    emitMetrics(hybridResult);
    return hybridResult;
  } catch (error) {
    // Fallback to rules
    // Fallback: use midpoint of ambiguous zone as threshold
    const midpoint = (AMBIGUOUS_ZONE_LOW + AMBIGUOUS_ZONE_HIGH) / 2;
    const label: VaguenessLabel = ruleScore >= midpoint ? 'vaga' : 'nao_vaga';
    const confidence = 0.5 + Math.abs(ruleScore - midpoint) / 100;
    const latencyMs = Date.now() - startedAt;

    logger.warn('Embedding classification failed, falling back to rules', {
      context: {
        requestId,
        ruleScore,
        label,
        error: error instanceof Error ? error.message : String(error),
      },
    });

    aiUsageTracker.record({
      timestamp: new Date().toISOString(),
      operation: 'classification:vagueness:fallback',
      model: 'rule-based',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      cacheHit: false,
      estimatedTokensSaved: 0,
      estimatedCostSavedUsd: null,
      latencyMs,
      requestId,
      routingMode: 'unknown',
      routingReason: null,
      cacheKeyVersion: null,
      fallbackUsed: true,
    });

    const fallbackResult: HybridClassificationResult = {
      label,
      ruleScore,
      embeddingScore: null,
      method: 'fallback',
      confidence,
      latencyMs,
      costUsd: 0,
    };
    emitMetrics(fallbackResult);
    return fallbackResult;
  }
}

/**
 * Reset exemplar embeddings cache (useful for tests).
 */
export function resetExemplarCache(): void {
  exemplarEmbeddingsCache = null;
}
