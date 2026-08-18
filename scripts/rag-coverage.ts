/**
 * B-1: RAG golden set coverage baseline.
 *
 * Gera relatório markdown com:
 * - % de cobertura das top 100 queries reais contra o golden set
 * - gaps ordenados por frequência
 * - entradas órfãs do golden set
 *
 * Uso:
 *   npm run rag:coverage
 *   npm run rag:coverage -- --queries-file queries.txt
 *   cat queries.txt | npm run rag:coverage
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { embeddingService } from '../server/services/embedding-service';
import { llmMetricsCollector } from '../server/services/llm-metrics-collector';
import { logger } from '../server/utils/logger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GOLDEN_PATH = path.resolve(__dirname, '../docs/golden-rag.json');
const REPORT_PATH = path.resolve(__dirname, '../docs/rag-coverage-report.md');
const TOP_N = 100;
const DEFAULT_THRESHOLD = 0.85;
const TEST_DIMENSIONS = 384;

function deterministicEmbedding(text: string): number[] {
  const vec = new Array(TEST_DIMENSIONS).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % TEST_DIMENSIONS] += text.charCodeAt(i) % 10;
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

type GoldenCase = {
  id: string;
  query: string;
  relevantSourceKeys: string[];
  notes: string;
};

type GoldenSet = {
  version: number;
  description: string;
  k: number;
  cases: GoldenCase[];
};

async function loadGoldenSet(): Promise<GoldenSet> {
  const raw = fs.readFileSync(GOLDEN_PATH, 'utf-8');
  return JSON.parse(raw) as GoldenSet;
}

async function loadQueriesFromArgs(): Promise<{ queries: string[]; source: string }> {
  const args = process.argv.slice(2);
  const fileArg = args.find((arg) => arg.startsWith('--queries-file='));

  if (fileArg) {
    const file = fileArg.split('=')[1];
    const text = fs.readFileSync(file, 'utf-8');
    return {
      queries: text.split(/\r?\n/).filter((q) => q.trim().length > 0),
      source: `arquivo ${file}`,
    };
  }

  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf-8');
    return {
      queries: text.split(/\r?\n/).filter((q) => q.trim().length > 0),
      source: 'stdin',
    };
  }

  // Fallback: tenta ler llm_operations por operation_type relevante
  await llmMetricsCollector.ensureTable();
  const rows = await llmMetricsCollector.getSummary();
  logger.info(
    'B-1: nenhuma fonte de queries externa fornecida; fallback para llm_operations ainda limitado',
    {
      context: { totalOps: rows.total, source: 'llm_operations' },
    },
  );
  return { queries: [], source: 'llm_operations (sem queries textuais)' };
}

function countFrequencies(queries: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const q of queries) {
    const normalized = q.trim().toLowerCase();
    freq.set(normalized, (freq.get(normalized) || 0) + 1);
  }
  return freq;
}

function buildReport(params: {
  goldenSet: GoldenSet;
  freq: Map<string, number>;
  topQueries: string[];
  coverage: number;
  threshold: number;
  thresholdValidated: boolean;
  gaps: Array<{ query: string; count: number; bestScore: number }>;
  orphans: Array<{ id: string; query: string; bestScore: number }>;
  source: string;
}): string {
  const thresholdFlag = params.thresholdValidated ? '[threshold validado]' : '[threshold pendente]';
  const coveragePct = params.topQueries.length > 0 ? (params.coverage * 100).toFixed(1) : 'A MEDIR';
  const topFreq = [...params.freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([q, c], i) => `${i + 1}. \`${q}\` (${c}x)`);

  const lines = [
    '# RAG Golden Set Coverage Report',
    '',
    `**Gerado em:** ${new Date().toISOString()}`,
    `**Fonte de queries:** ${params.source}`,
    `**Threshold de similaridade cosseno:** ${params.threshold} ${thresholdFlag}`,
    `**Versão do golden set:** ${params.goldenSet.version}`,
    `**Total de entradas no golden set:** ${params.goldenSet.cases.length}`,
    `**Queries únicas analisadas:** ${params.freq.size}`,
    `**Queries reais consideradas (top ${TOP_N} por frequência):** ${params.topQueries.length}`,
    `**Cobertura:** ${coveragePct}%`,
    '',
    '## Top queries reais por frequência',
    '',
    ...topFreq,
    '',
    '## Gaps (queries reais frequentes não cobertas pelo golden set)',
    '',
    params.gaps.length === 0
      ? 'Nenhum gap identificado.'
      : params.gaps
          .map((g) => `- \`${g.query}\` (${g.count}x, melhor score: ${g.bestScore.toFixed(3)})`)
          .join('\n'),
    '',
    '## Entradas órfãs do golden set (sem similaridade suficiente com queries reais)',
    '',
    params.orphans.length === 0
      ? 'Nenhuma entrada órfã.'
      : params.orphans
          .map((o) => `- **${o.id}**: \`${o.query}\` (melhor score: ${o.bestScore.toFixed(3)})`)
          .join('\n'),
    '',
    '## Processo trimestral de revisão',
    '',
    '1. Executar `npm run rag:coverage` com as queries do último trimestre.',
    '2. Revisar gaps e entradas órfãs com o PO (estimado: 30 min).',
    '3. Adicionar 5-10 novas entradas ao `docs/golden-rag.json` para cobrir os gaps principais.',
    '4. Reexecutar o script e verificar se cobertura das top 100 queries ≥ 70%.',
    '',
    '## Métricas',
    '',
    '| Métrica | Antes | Depois |',
    '|---------|-------|--------|',
    `| Cobertura das top ${TOP_N} queries | A MEDIR — sem baseline | ${coveragePct}% |`,
    `| Queries únicas analisadas | A MEDIR — sem baseline | ${params.freq.size} |`,
  ];

  return lines.join('\n');
}

async function main() {
  const goldenSet = await loadGoldenSet();
  const { queries, source } = await loadQueriesFromArgs();

  if (queries.length === 0) {
    logger.warn('B-1: nenhuma query real fornecida. Relatório terá cobertura A MEDIR.');
  }

  const freq = countFrequencies(queries);
  const topQueries = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([q]) => q);

  const allGoldenQueries = goldenSet.cases.map((c) => c.query);
  const allUniqueQueries = [...new Set([...allGoldenQueries, ...topQueries])];

  const isTestMode = process.argv.includes('--local-test');

  let allEmbeddings: number[][] = [];
  try {
    allEmbeddings = isTestMode
      ? allUniqueQueries.map((q) => deterministicEmbedding(q))
      : await embeddingService.getEmbeddings(allUniqueQueries);
  } catch (err) {
    logger.error('B-1: falha ao gerar embeddings', { error: err });
    process.exit(1);
  }

  const queryMap = new Map<string, number[]>();
  for (let i = 0; i < allUniqueQueries.length; i++) {
    queryMap.set(allUniqueQueries[i], allEmbeddings[i]);
  }

  const threshold = DEFAULT_THRESHOLD;
  const thresholdValidated = process.argv.includes('--threshold-validated');

  let covered = 0;
  const gaps: Array<{ query: string; count: number; bestScore: number }> = [];

  for (const query of topQueries) {
    const embedding = queryMap.get(query);
    if (!embedding) continue;

    let bestScore = 0;
    for (const goldenQuery of allGoldenQueries) {
      const goldenEmbedding = queryMap.get(goldenQuery);
      if (!goldenEmbedding) continue;
      const score = embeddingService.cosineSimilarity(embedding, goldenEmbedding);
      if (score > bestScore) bestScore = score;
    }

    if (bestScore >= threshold) {
      covered++;
    } else {
      gaps.push({ query, count: freq.get(query) || 0, bestScore });
    }
  }

  const coverage = topQueries.length > 0 ? covered / topQueries.length : 0;

  const orphans: Array<{ id: string; query: string; bestScore: number }> = [];
  for (const goldenCase of goldenSet.cases) {
    const goldenEmbedding = queryMap.get(goldenCase.query);
    if (!goldenEmbedding) continue;

    let bestScore = 0;
    for (const query of topQueries) {
      const embedding = queryMap.get(query);
      if (!embedding) continue;
      const score = embeddingService.cosineSimilarity(goldenEmbedding, embedding);
      if (score > bestScore) bestScore = score;
    }

    if (bestScore < threshold) {
      orphans.push({ id: goldenCase.id, query: goldenCase.query, bestScore });
    }
  }

  const report = buildReport({
    goldenSet,
    freq,
    topQueries,
    coverage,
    threshold,
    thresholdValidated,
    gaps: gaps.sort((a, b) => b.count - a.count),
    orphans: orphans.sort((a, b) => a.bestScore - b.bestScore),
    source,
  });

  fs.writeFileSync(REPORT_PATH, report, 'utf-8');
  logger.info('B-1: relatório de cobertura gerado', { context: { path: REPORT_PATH, coverage } });
  console.log(report);
}

main().catch((err) => {
  logger.error('B-1: erro no script rag:coverage', { error: err });
  process.exit(1);
});
