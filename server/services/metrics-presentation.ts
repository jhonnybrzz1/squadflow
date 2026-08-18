/**
 * Demanda 10093 — apresentação honesta de métricas de custo e latência.
 *
 * Dois problemas que o dashboard tinha e que este módulo resolve na origem:
 *
 *  1. **Percentil de amostra minúscula parece estatística.** Com n=2, um "p95"
 *     é o maior dos dois valores — número com aparência de rigor e nenhuma
 *     confiança. Abaixo do limiar devolvemos `insufficientSample`, não um valor.
 *
 *  2. **Custo sem unidade explícita engana.** "0.002" pode ser lido como 2
 *     centavos ou 2 milésimos de dólar. Exibimos os dois campos separados
 *     (USD e mUSD) em vez de escolher um e torcer para o leitor adivinhar.
 */

/** Abaixo disto, um percentil não tem confiança suficiente para ser exibido. */
export const MIN_SAMPLE_FOR_PERCENTILE = 10;

export interface PercentileResult {
  /** Valor do percentil, ou `null` quando a amostra é insuficiente. */
  value: number | null;
  sampleSize: number;
  /** true quando `sampleSize < MIN_SAMPLE_FOR_PERCENTILE`. */
  insufficientSample: boolean;
}

/**
 * Percentil por interpolação linear (mesmo método do `numpy.percentile`), com
 * guarda de amostra. `p` em 0..100.
 */
export function percentileWithGuard(
  values: number[],
  p: number,
  minSample: number = MIN_SAMPLE_FOR_PERCENTILE,
): PercentileResult {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  const sampleSize = clean.length;

  if (sampleSize < minSample) {
    return { value: null, sampleSize, insufficientSample: true };
  }

  const sorted = [...clean].sort((a, b) => a - b);
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const value =
    low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (rank - low);

  return { value, sampleSize, insufficientSample: false };
}

export interface CostDisplay {
  /** Valor em dólares. */
  usd: number;
  /** Mesmo valor em milésimos de dólar — evita ler 0.002 como 2 centavos. */
  mUsd: number;
}

/** Separa o custo nas duas unidades em vez de escolher uma ambígua. */
export function formatCost(usd: number | null | undefined): CostDisplay {
  const safe = typeof usd === 'number' && Number.isFinite(usd) ? usd : 0;
  return { usd: safe, mUsd: safe * 1000 };
}

export interface Decomposition {
  key: string;
  requests: number;
  totalCost: CostDisplay;
  avgLatencyMs: number | null;
  p95LatencyMs: PercentileResult;
}

/**
 * Decompõe custo e latência por uma chave (agente ou modelo). Cada grupo carrega
 * a própria guarda de amostra — um agente com 3 chamadas não ganha p95 só porque
 * o total geral passou do limiar.
 */
export function decomposeBy<T>(
  records: T[],
  keyOf: (r: T) => string | null | undefined,
  costOf: (r: T) => number | null | undefined,
  latencyOf: (r: T) => number | null | undefined,
): Decomposition[] {
  const groups = new Map<string, { costs: number[]; latencies: number[] }>();

  for (const record of records) {
    const key = keyOf(record);
    if (!key) continue;
    const group = groups.get(key) ?? { costs: [], latencies: [] };
    const cost = costOf(record);
    if (typeof cost === 'number' && Number.isFinite(cost)) group.costs.push(cost);
    const latency = latencyOf(record);
    if (typeof latency === 'number' && Number.isFinite(latency)) group.latencies.push(latency);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      requests: Math.max(g.costs.length, g.latencies.length),
      totalCost: formatCost(g.costs.reduce((a, b) => a + b, 0)),
      avgLatencyMs: g.latencies.length
        ? g.latencies.reduce((a, b) => a + b, 0) / g.latencies.length
        : null,
      p95LatencyMs: percentileWithGuard(g.latencies, 95),
    }))
    .sort((a, b) => b.totalCost.usd - a.totalCost.usd);
}
