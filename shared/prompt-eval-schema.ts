import { z } from 'zod';

/**
 * Schema for a single Q&A evaluation pair.
 */
export const EvalPairSchema = z
  .object({
    id: z.string().regex(/^eval-\d{3}$/, 'ID must be in format eval-XXX'),
    categoria: z.enum(['geral', 'erro']),
    dificuldade: z.enum(['simples', 'intermediario', 'complexo']),
    pergunta: z.string().min(10, 'Pergunta deve ter pelo menos 10 caracteres'),
    resposta_esperada: z.string().min(20, 'Resposta esperada deve ter pelo menos 20 caracteres'),
    tokens_estruturais: z
      .array(z.string())
      .min(1, 'Deve ter pelo menos 1 token estrutural')
      .describe('Tokens que devem aparecer na resposta (fonte, valor, data, etc.)'),
    fontes_validas: z
      .array(z.string())
      .describe('Fontes válidas que podem ser citadas na resposta'),
  })
  .superRefine((pair, ctx) => {
    if (pair.categoria !== 'erro' && pair.fontes_validas.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fontes_validas'],
        message: 'Casos substantivos exigem pelo menos uma fonte valida.',
      });
    }
  });

/**
 * Schema for the complete evaluation dataset.
 */
export const EvalDatasetSchema = z.object({
  description: z.string(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  target_similarity_pct: z.number().min(0).max(100),
  target_structure_pct: z.number().min(0).max(100),
  created_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  categories: z.array(z.enum(['geral', 'erro'])),
  pairs: z.array(EvalPairSchema).min(1),
});

/**
 * Schema for a single evaluation result.
 */
export const EvalResultSchema = z.object({
  pair_id: z.string(),
  similarity: z.number().min(0).max(1),
  tokens_presentes: z.array(z.string()),
  tokens_ausentes: z.array(z.string()),
  tokens_pct: z.number().min(0).max(100),
  fontes_presentes: z.array(z.string()).optional(),
  fontes_ausentes: z.array(z.string()).optional(),
  fontes_pct: z.number().min(0).max(100).optional(),
  groundedness: z.number().min(0).max(1).optional(),
  error_handling: z.number().min(0).max(1).optional(),
  quality_score: z.number().min(0).max(100).optional(),
  status: z.enum(['pass', 'fail', 'skip']),
  reason: z.string().optional(),
  latency_ms: z.number().optional(),
});

/**
 * Schema for the complete evaluation report.
 */
export const EvalReportSchema = z.object({
  dataset_version: z.string(),
  evaluated_at: z.string(),
  total_pairs: z.number(),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  avg_similarity: z.number(),
  avg_tokens_pct: z.number(),
  avg_fontes_pct: z.number().optional(),
  avg_groundedness: z.number().optional(),
  avg_error_handling: z.number().optional(),
  avg_quality_score: z.number().optional(),
  avg_latency_ms: z.number().optional(),
  results: z.array(EvalResultSchema),
  summary: z.object({
    by_categoria: z.record(
      z.string(),
      z.object({
        total: z.number(),
        passed: z.number(),
        avg_similarity: z.number(),
      }),
    ),
    by_dificuldade: z.record(
      z.string(),
      z.object({
        total: z.number(),
        passed: z.number(),
        avg_similarity: z.number(),
      }),
    ),
  }),
});

// Type exports
export type EvalPair = z.infer<typeof EvalPairSchema>;
export type EvalDataset = z.infer<typeof EvalDatasetSchema>;
export type EvalResult = z.infer<typeof EvalResultSchema>;
export type EvalReport = z.infer<typeof EvalReportSchema>;

/**
 * Validate and parse the evaluation dataset.
 */
export function validateEvalDataset(data: unknown): EvalDataset {
  return EvalDatasetSchema.parse(data);
}

/**
 * Safe validation that returns success/error.
 */
export function safeValidateEvalDataset(data: unknown): {
  success: boolean;
  data?: EvalDataset;
  error?: z.ZodError;
} {
  const result = EvalDatasetSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Calculate structural token match percentage.
 */
export function calculateTokenMatch(
  response: string,
  expectedTokens: string[],
): { present: string[]; absent: string[]; percentage: number } {
  const responseLower = normalizeForEval(response);
  const present: string[] = [];
  const absent: string[] = [];

  for (const token of expectedTokens) {
    if (responseLower.includes(normalizeForEval(token))) {
      present.push(token);
    } else {
      absent.push(token);
    }
  }

  const percentage =
    expectedTokens.length > 0 ? (present.length / expectedTokens.length) * 100 : 100;

  return { present, absent, percentage };
}

export function normalizeForEval(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s%.,/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function calculateSourceGrounding(
  response: string,
  validSources: string[],
): {
  present: string[];
  absent: string[];
  percentage: number;
  groundedness: number;
} {
  if (validSources.length === 0) {
    return { present: [], absent: [], percentage: 100, groundedness: 1 };
  }

  const normalizedResponse = normalizeForEval(response);
  const present = validSources.filter((source) =>
    normalizedResponse.includes(normalizeForEval(source)),
  );
  const absent = validSources.filter((source) => !present.includes(source));
  const groundedness = present.length > 0 ? 1 : 0;

  return {
    present,
    absent,
    percentage: groundedness * 100,
    groundedness,
  };
}

export function calculateErrorHandling(response: string, category: EvalPair['categoria']): number {
  if (category !== 'erro') {
    return 1;
  }

  const normalizedResponse = normalizeForEval(response);
  const refusalSignals = [
    'nao',
    'impossivel',
    'inval',
    'indisponivel',
    'generica',
    'branco',
    'reformule',
    'especifique',
    'nao entendi',
  ];

  return refusalSignals.some((signal) => normalizedResponse.includes(signal)) ? 1 : 0;
}

export function calculateCompositeQualityScore(input: {
  similarity: number;
  tokensPct: number;
  groundedness: number;
  errorHandling: number;
}): number {
  const score =
    input.similarity * 40 +
    (input.tokensPct / 100) * 25 +
    input.groundedness * 25 +
    input.errorHandling * 10;

  return Math.round(score * 100) / 100;
}
