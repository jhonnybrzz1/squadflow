/**
 * Query Intent Detection
 *
 * Classifies user queries into intent categories to optimize RAG retrieval strategy.
 * Each intent maps to different retrieval parameters:
 *
 * - factual:     Direct lookups, favor exact match + high precision
 * - procedural:  Step-by-step processes, favor parent chunks for full context
 * - comparative: Comparing options, favor MMR for diversity
 * - regulatory:  Legal/regulatory queries, favor metadata filtering by eixo
 * - general:     Default, uses balanced hybrid search
 */

export type QueryIntent = 'factual' | 'procedural' | 'comparative' | 'regulatory' | 'general';

export interface QueryIntentResult {
  intent: QueryIntent;
  confidence: number; // 0-1
  matchedKeywords: string[];
  suggestedParams: RetrievalParams;
}

interface RetrievalParams {
  topK: number;
  hybridWeight: number; // 0 = keyword-only, 1 = semantic-only
  useReranking: boolean;
  useMMR: boolean;
  mmrLambda: number; // 0 = max diversity, 1 = max relevance
  useParentRetrieval: boolean;
  useCompression: boolean;
  fetchK: number;
}

/**
 * Normalize text: strip accents and lowercase.
 */
function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Keyword patterns for each intent category.
 * Keywords are stored in normalized (accent-stripped) form.
 * Supports Portuguese (primary) and English keywords.
 */
const INTENT_PATTERNS: Record<QueryIntent, { keywords: string[]; weight: number }> = {
  factual: {
    keywords: [
      'o que e',
      'o que sao',
      'qual e',
      'qual o',
      'quando',
      'quem',
      'onde',
      'quanto',
      'define',
      'definicao',
      'significado',
      'what is',
      'when',
      'who',
      'where',
      'how much',
    ],
    weight: 1.0,
  },
  procedural: {
    keywords: [
      'como',
      'passo a passo',
      'processo',
      'etapas',
      'procedimento',
      'tutorial',
      'instrucoes',
      'fluxo',
      'workflow',
      'sequencia',
      'para que serve',
      'como funciona',
      'como fazer',
      'how to',
      'step by step',
      'process',
      'guide',
    ],
    weight: 1.0,
  },
  comparative: {
    keywords: [
      'diferenca',
      'diferente',
      'melhor',
      'versus',
      'comparar',
      'comparacao',
      'vantagem',
      'desvantagem',
      'pros',
      'contras',
      'alternativa',
      'entre',
      'qual a diferenca',
      'em relacao a',
      'difference',
      'better',
      'vs',
      'compare',
      'pros cons',
    ],
    weight: 1.0,
  },
  regulatory: {
    keywords: [
      'resolucao',
      'circular',
      'normativa',
      'obrigatorio',
      'regulamento',
      'legislacao',
      'lei',
      'decreto',
      'instrucao',
      'portaria',
      'prazo legal',
      'penalidade',
      'multa',
      'infracao',
      'resolution',
      'regulation',
      'mandatory',
      'compliance',
    ],
    weight: 1.2, // Slightly higher weight for regulatory (domain-specific)
  },
  general: {
    keywords: [],
    weight: 0.5,
  },
};

/**
 * Default retrieval parameters per intent.
 */
const INTENT_PARAMS: Record<QueryIntent, RetrievalParams> = {
  factual: {
    topK: 4,
    hybridWeight: 0.6,
    useReranking: true,
    useMMR: false,
    mmrLambda: 0.7,
    useParentRetrieval: false,
    useCompression: true, // Extract precise answer
    fetchK: 12,
  },
  procedural: {
    topK: 6,
    hybridWeight: 0.5,
    useReranking: true,
    useMMR: false,
    mmrLambda: 0.5,
    useParentRetrieval: true, // Need full context for steps
    useCompression: false,
    fetchK: 18,
  },
  comparative: {
    topK: 8,
    hybridWeight: 0.7,
    useReranking: true,
    useMMR: true, // Diversity to get both sides
    mmrLambda: 0.4, // Favor diversity
    useParentRetrieval: false,
    useCompression: false,
    fetchK: 24,
  },
  regulatory: {
    topK: 6,
    hybridWeight: 0.8, // Strong semantic for legal language
    useReranking: true,
    useMMR: false,
    mmrLambda: 0.7,
    useParentRetrieval: true, // Need full article context
    useCompression: false,
    fetchK: 18,
  },
  general: {
    topK: 6,
    hybridWeight: 0.5,
    useReranking: false,
    useMMR: false,
    mmrLambda: 0.5,
    useParentRetrieval: false,
    useCompression: false,
    fetchK: 12,
  },
};

/**
 * Detect query intent based on keyword matching.
 *
 * @param query - The user's search query
 * @returns Intent classification with confidence and suggested retrieval params
 */
export function detectQueryIntent(query: string): QueryIntentResult {
  const lower = normalizeText(query);

  let bestIntent: QueryIntent = 'general';
  let bestScore = 0;
  let bestMatches: string[] = [];

  for (const [intent, config] of Object.entries(INTENT_PATTERNS)) {
    if (intent === 'general') continue;

    const matched = config.keywords.filter((kw) => lower.includes(kw));
    const score = matched.length * config.weight;

    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent as QueryIntent;
      bestMatches = matched;
    }
  }

  // Confidence based on match strength
  const confidence = bestScore === 0 ? 0.3 : Math.min(1.0, 0.5 + bestScore * 0.15);

  return {
    intent: bestIntent,
    confidence,
    matchedKeywords: bestMatches,
    suggestedParams: { ...INTENT_PARAMS[bestIntent] },
  };
}

/**
 * Get retrieval parameters optimized for a given intent.
 */
export function getRetrievalParamsForIntent(intent: QueryIntent): RetrievalParams {
  return { ...INTENT_PARAMS[intent] };
}

/**
 * Merge intent-suggested params with user-provided overrides.
 * User overrides take precedence.
 */
export function mergeRetrievalParams(
  intentParams: RetrievalParams,
  overrides: Partial<RetrievalParams>,
): RetrievalParams {
  return { ...intentParams, ...overrides };
}
