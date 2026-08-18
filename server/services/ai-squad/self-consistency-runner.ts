import { logger } from '../../utils/logger';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface SelfConsistencyResult<T> {
  /** Decisão vencedora (maioria dos votos) */
  winner: T;
  /** votos_maioria / N — entre 0 e 1 */
  confidence: number;
  /** Quantos votos cada chave recebeu */
  voteDistribution: Record<string, number>;
  /** Todas as amostras bem-sucedidas */
  samples: T[];
}

export interface SelfConsistencyOptions {
  /** Número de amostras a coletar. Precede o env; se omitido, usa SELF_CONSISTENCY_N (default 2). */
  n?: number;
  /** Nome do ponto de julgamento para logs */
  label?: string;
}

/**
 * Spec 10039 T9 — otimização de custo: N padrão configurável via env.
 * Precedência: `options.n` explícito > `SELF_CONSISTENCY_N` > default 2.
 * N=2 reduz ~33% do custo por julgamento vs. N=3, mantido como opção.
 */
export const DEFAULT_SELF_CONSISTENCY_N = 2;

export function resolveSelfConsistencyN(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  const fromEnv = Number.parseInt(process.env.SELF_CONSISTENCY_N || '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_SELF_CONSISTENCY_N;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

/**
 * Executa `sampleFn` N vezes em paralelo, agrega por voto majoritário
 * usando `keyFn` para agrupar amostras equivalentes, e retorna o resultado
 * com confiança = votos_maioria / N.
 *
 * @param sampleFn   Função que gera uma amostra (chamada de LLM de julgamento)
 * @param keyFn      Função que converte uma amostra na sua "chave de voto"
 * @param aggregateFn Função que, dado o grupo de amostras vencedoras, retorna o winner
 * @param options    { n, label }
 */
export async function runWithSelfConsistency<T>(
  sampleFn: () => Promise<T>,
  keyFn: (sample: T) => string,
  aggregateFn: (winnerSamples: T[]) => T,
  options: SelfConsistencyOptions = {},
): Promise<SelfConsistencyResult<T>> {
  const n = resolveSelfConsistencyN(options.n);
  const label = options.label ?? 'self-consistency';

  // Executa N amostras em paralelo
  const results = await Promise.allSettled(Array.from({ length: n }, () => sampleFn()));

  const samples: T[] = results
    .filter((r): r is PromiseFulfilledResult<Awaited<T>> => r.status === 'fulfilled')
    .map((r) => r.value);

  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    logger.warn(`[SelfConsistency:${label}] ${failed}/${n} amostras falharam`);
  }

  // Sem amostras válidas — usa fallback direto
  if (samples.length === 0) {
    logger.error(`[SelfConsistency:${label}] Todas as ${n} amostras falharam`);
    // Tenta uma última vez de forma síncrona
    const fallback = await sampleFn();
    return {
      winner: fallback,
      confidence: 0,
      voteDistribution: {},
      samples: [fallback],
    };
  }

  // Agrupa por chave de voto
  const voteDistribution: Record<string, number> = {};
  const buckets: Record<string, T[]> = {};

  for (const sample of samples) {
    const key = keyFn(sample);
    voteDistribution[key] = (voteDistribution[key] ?? 0) + 1;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(sample);
  }

  // Encontra a chave com mais votos
  const winnerKey = Object.entries(voteDistribution).sort(([, a], [, b]) => b - a)[0][0];
  const winnerVotes = voteDistribution[winnerKey];
  // Confiança sobre amostras VÁLIDAS (não sobre N configurado): se amostras
  // falham, dividir por N subestimaria a confiança e dispararia rodadas extras
  // espúrias. Quando nenhuma amostra falha, samples.length === n.
  const confidence = winnerVotes / samples.length;

  const winner = aggregateFn(buckets[winnerKey]);

  logger.info(
    `[SelfConsistency:${label}] confidence=${confidence.toFixed(2)} votes=${JSON.stringify(voteDistribution)}`,
  );

  return { winner, confidence, voteDistribution, samples };
}

// ─── Agregadores padrão ───────────────────────────────────────────────────────

/**
 * Agrega pegando a primeira amostra do grupo vencedor.
 * Suficiente para decisões discretas (ex: next_speaker, should_continue).
 */
export function aggregateFirst<T>(samples: T[]): T {
  return samples[0];
}

/**
 * Agrega severidade CATEGÓRICA (ALTA/BAIXA) por voto majoritário.
 *
 * A severidade no juiz red-team é um enum categórico (z.enum(['ALTA','BAIXA'])),
 * não numérica — portanto "mediana" não se aplica. Em caso de empate, escala
 * para 'ALTA' (conservador: nunca subestima o risco de uma falha confirmada).
 */
export function aggregateMajoritySeverity(severities: string[]): 'ALTA' | 'BAIXA' {
  let alta = 0;
  let baixa = 0;
  for (const s of severities) {
    if (String(s).toUpperCase() === 'ALTA') alta += 1;
    else baixa += 1;
  }
  return alta >= baixa ? 'ALTA' : 'BAIXA';
}
