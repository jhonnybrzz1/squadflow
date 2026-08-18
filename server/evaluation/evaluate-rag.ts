import { resolvePath } from '@shared/utils/paths';
/**
 * RAG Retrieval Evaluation — recall@k / precision@k gate over a labeled golden set.
 *
 * Loads docs/golden-rag.json (query → relevantSourceKeys), runs
 * refinementRagService.retrieveHybrid() on each query, and computes
 * recall@k / precision@k / reciprocalRank via calculateRetrievalMetrics.
 *
 * Writes a JSON report and exits 1 if mean recall@k falls below the baseline
 * floor (docs/evaluation-baseline.json → rag.minRecallAtK).
 *
 * Design: this exercises the REAL retrieval pipeline (embeddings + vector
 * search + rerank), so it requires the same env vars as the app (DB,
 * embeddings API). It is therefore suited to the nightly run; in smoke mode
 * it runs the first 5 cases for a fast signal.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { refinementRAGService } from '../services/refinement-rag';
import { calculateRetrievalMetrics, type RetrievalMetrics } from './retrieval-metrics';

interface RagCase {
  id: string;
  query: string;
  relevantSourceKeys: string[];
  notes?: string;
}

interface RagCaseResult extends RagCase {
  retrievedSourceKeys: string[];
  metrics: RetrievalMetrics;
}

interface RagEvalReport {
  mode: 'smoke' | 'full';
  generatedAt: string;
  sampleSize: number;
  k: number;
  meanRecallAtK: number;
  meanPrecisionAtK: number;
  meanReciprocalRank: number;
  casesWithZeroRecall: string[];
  baselineFloor: number | null;
  passed: boolean;
  cases: RagCaseResult[];
}

function loadGoldenSet(smoke: boolean): { cases: RagCase[]; k: number } {
  const file = resolvePath('docs/golden-rag.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { cases: RagCase[]; k: number };
  const cases = smoke ? data.cases.slice(0, 5) : data.cases;
  return { cases, k: data.k ?? 5 };
}

function loadBaselineFloor(): { floor: number | null; k: number } {
  const baselineFile = resolvePath('docs/evaluation-baseline.json');
  if (!fs.existsSync(baselineFile)) return { floor: null, k: 5 };
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')) as {
    rag?: { minRecallAtK?: number; k?: number };
  };
  return { floor: baseline.rag?.minRecallAtK ?? null, k: baseline.rag?.k ?? 5 };
}

async function main() {
  const args = process.argv.slice(2);
  const smoke = args.includes('--smoke');
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : undefined;

  console.log('\n========================================================================');
  console.log('🔍 RAG RETRIEVAL EVAL — recall@k / precision@k over golden set');
  console.log('========================================================================');

  const { cases } = loadGoldenSet(smoke);
  const { floor: baselineFloor, k: baselineK } = loadBaselineFloor();
  const k = baselineK;

  const results: RagCaseResult[] = [];
  let totalRecall = 0;
  let totalPrecision = 0;
  let totalRR = 0;
  const zeroRecall: string[] = [];

  for (const c of cases) {
    try {
      const retrieved = await refinementRAGService.retrieveHybrid(c.query, k, {});
      const retrievedKeys = retrieved.map((r: { sourceKey: string }) => r.sourceKey);
      const metrics = calculateRetrievalMetrics(retrievedKeys, c.relevantSourceKeys, k);
      totalRecall += metrics.recallAtK;
      totalPrecision += metrics.precisionAtK;
      totalRR += metrics.reciprocalRank;
      if (metrics.recallAtK === 0) zeroRecall.push(c.id);
      results.push({ ...c, retrievedSourceKeys: retrievedKeys, metrics });
      console.log(
        `  ${metrics.recallAtK > 0 ? '✓' : '✗'} ${c.id} recall@${k}=${metrics.recallAtK.toFixed(2)} precision@${k}=${metrics.precisionAtK.toFixed(2)} rr=${metrics.reciprocalRank.toFixed(2)} | ${c.query.slice(0, 50)}`,
      );
    } catch (err) {
      console.error(`  ✗ ${c.id} ERRO: ${err instanceof Error ? err.message : String(err)}`);
      results.push({
        ...c,
        retrievedSourceKeys: [],
        metrics: { recallAtK: 0, precisionAtK: 0, reciprocalRank: 0 },
      });
      zeroRecall.push(c.id);
      totalRecall += 0;
      totalPrecision += 0;
      totalRR += 0;
    }
  }

  const n = cases.length;
  const meanRecallAtK = n > 0 ? totalRecall / n : 0;
  const meanPrecisionAtK = n > 0 ? totalPrecision / n : 0;
  const meanReciprocalRank = n > 0 ? totalRR / n : 0;
  const passed = baselineFloor === null ? true : meanRecallAtK >= baselineFloor;

  console.log('\n------------------------------------------------------------------------');
  console.log(`Mean recall@${k}:        ${meanRecallAtK.toFixed(3)}`);
  console.log(`Mean precision@${k}:     ${meanPrecisionAtK.toFixed(3)}`);
  console.log(`Mean reciprocal rank:    ${meanReciprocalRank.toFixed(3)}`);
  console.log(`Cases with zero recall:  ${zeroRecall.length}/${n}`);
  if (baselineFloor !== null) {
    console.log(`Baseline floor (recall): ${baselineFloor.toFixed(3)}`);
    console.log(`Gate: ${passed ? 'PASS ✅' : 'FAIL ❌'}`);
  }
  console.log('========================================================================\n');

  const report: RagEvalReport = {
    mode: smoke ? 'smoke' : 'full',
    generatedAt: new Date().toISOString(),
    sampleSize: n,
    k,
    meanRecallAtK,
    meanPrecisionAtK,
    meanReciprocalRank,
    casesWithZeroRecall: zeroRecall,
    baselineFloor,
    passed,
    cases: results,
  };

  if (outputPath) {
    const resolved = resolvePath(outputPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  process.exitCode = passed ? 0 : 1;
}

main().catch((err) => {
  console.error('RAG eval crashed:', err);
  process.exitCode = 1;
});
