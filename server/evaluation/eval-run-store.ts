import { resolvePath } from '@shared/utils/paths';
/**
 * Run store da avaliação de agentes (spec 006 / US3).
 *
 * Cada execução vira um run versionado em artifacts/eval-runs/<runId>/run.json,
 * com uma linha de descoberta em artifacts/eval-runs/index.jsonl (append-only).
 *
 * REGRA (FR-005): o registro é aditivo e best-effort — nenhuma falha de escrita
 * pode quebrar a avaliação nem o gate de CI. Toda função de escrita captura o
 * erro, loga em stderr e segue.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { z } from 'zod';
import { logger } from '../utils/logger';

export const callStatsSchema = z.object({
  model: z.string(),
  promptTokens: z.number().nonnegative(),
  completionTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
});

export type CallStats = z.infer<typeof callStatsSchema>;

export const evalCaseResultSchema = z.object({
  id: z.string(),
  agent: z.string(),
  scores: z.record(z.number().min(0).max(5)),
  avgScore: z.number(),
  closerTo: z.enum(['valid', 'rejected']),
  rationale: z.string(),
  agentCall: callStatsSchema,
  judgeCall: callStatsSchema,
  output: z.string(),
});

export type EvalCaseResult = z.infer<typeof evalCaseResultSchema>;

export const evalRunParamsSchema = z.object({
  agentModels: z.record(z.string()),
  judgeModel: z.string(),
  temperature: z.record(z.number()),
  maxTokens: z.record(z.number()),
  datasetSize: z.record(z.object({ train: z.number(), holdout: z.number() })),
  deviations: z.array(z.string()),
  mode: z.enum(['full', 'dry-run', 'smoke']),
  sameProviderJudge: z.array(z.string()),
});

export type EvalRunParams = z.infer<typeof evalRunParamsSchema>;

export const evalRunMetricsSchema = z.object({
  overall: z.number(),
  byCriterion: z.record(z.number()),
  byAgent: z.record(
    z.object({
      overall: z.number(),
      inconclusive: z.boolean(),
      costUsd: z.number(),
      latencyP50Ms: z.number(),
      latencyP95Ms: z.number(),
    }),
  ),
  totalCostUsd: z.number(),
});

export type EvalRunMetrics = z.infer<typeof evalRunMetricsSchema>;

export const evalRunSchema = z.object({
  runId: z.string(),
  generatedAt: z.string(),
  gitCommit: z.string().optional(),
  params: evalRunParamsSchema,
  metrics: evalRunMetricsSchema,
  cases: z.array(evalCaseResultSchema),
  passed: z.boolean(),
  inconclusiveAgents: z.array(z.string()),
  judgeConcordance: z.union([z.number(), z.literal('unmeasured')]),
});

export type EvalRun = z.infer<typeof evalRunSchema>;

export interface EvalRunIndexEntry {
  runId: string;
  generatedAt: string;
  gitCommit?: string;
  overall: number;
  passed: boolean;
  totalCostUsd: number;
  mode: EvalRunParams['mode'];
}

const DEFAULT_DIR = resolvePath('artifacts/eval-runs');

export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

export function currentGitCommit(): string | undefined {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch (_) {
    return undefined;
  }
}

/**
 * Persiste o run. Best-effort: retorna o caminho gravado ou null em falha,
 * nunca lança (FR-005).
 */
export function saveRun(run: EvalRun, baseDir = DEFAULT_DIR): string | null {
  try {
    const runDir = path.join(baseDir, run.runId);
    fs.mkdirSync(runDir, { recursive: true });
    const runPath = path.join(runDir, 'run.json');
    fs.writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');

    const indexEntry: EvalRunIndexEntry = {
      runId: run.runId,
      generatedAt: run.generatedAt,
      gitCommit: run.gitCommit,
      overall: run.metrics.overall,
      passed: run.passed,
      totalCostUsd: run.metrics.totalCostUsd,
      mode: run.params.mode,
    };
    fs.appendFileSync(path.join(baseDir, 'index.jsonl'), `${JSON.stringify(indexEntry)}\n`, 'utf8');
    return runPath;
  } catch (error) {
    logger.warn('Falha ao gravar run (registro é aditivo; avaliação segue)', {
      context: { runId: run.runId },
      error: error instanceof Error ? error : undefined,
    });
    return null;
  }
}

/** Carrega um run pelo id; lança se não existir ou não validar (uso analítico). */
export function loadRun(runId: string, baseDir = DEFAULT_DIR): EvalRun {
  const raw = fs.readFileSync(path.join(baseDir, runId, 'run.json'), 'utf8');
  return evalRunSchema.parse(JSON.parse(raw));
}

/** Lista as entradas do índice (mais recentes por último). */
export function listRuns(baseDir = DEFAULT_DIR): EvalRunIndexEntry[] {
  try {
    const raw = fs.readFileSync(path.join(baseDir, 'index.jsonl'), 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        try {
          return JSON.parse(line) as EvalRunIndexEntry;
        } catch (parseError) {
          // Spec 10125 #15: índice quebrado não pode ser engolido silenciosamente.
          logger.error('Entrada de índice de eval-runs corrompida', {
            context: { lineIndex: index, line: line.slice(0, 200) },
            error: parseError instanceof Error ? parseError : undefined,
          });
          throw parseError;
        }
      });
  } catch (error) {
    logger.error('Falha ao ler índice de eval-runs', {
      context: { baseDir },
      error: error instanceof Error ? error : undefined,
    });
    throw error;
  }
}

/** Resolve aliases `latest`/`latest-1` para runIds reais via índice. */
export function resolveRunAlias(alias: string, baseDir = DEFAULT_DIR): string {
  if (alias !== 'latest' && alias !== 'latest-1') return alias;
  const entries = listRuns(baseDir);
  if (entries.length === 0) throw new Error('Nenhum run no índice para resolver alias');
  const offset = alias === 'latest' ? 1 : 2;
  if (entries.length < offset) throw new Error(`Índice tem apenas ${entries.length} run(s)`);
  return entries[entries.length - offset].runId;
}

export interface RunComparison {
  runA: string;
  runB: string;
  byCriterion: Record<string, { a: number | null; b: number | null; delta: number | null }>;
  byAgent: Record<
    string,
    {
      overallDelta: number | null;
      costDelta: number | null;
      p95Delta: number | null;
    }
  >;
  closerToChanges: Array<{ id: string; from: string; to: string }>;
  overallDelta: number;
  costDelta: number;
}

/** Compara dois runs por critério de rubrica, agente e custo (FR-007/SC-003). */
export function compareRuns(a: EvalRun, b: EvalRun): RunComparison {
  const criteria = new Set([
    ...Object.keys(a.metrics.byCriterion),
    ...Object.keys(b.metrics.byCriterion),
  ]);
  const byCriterion: RunComparison['byCriterion'] = {};
  for (const criterion of criteria) {
    const va = a.metrics.byCriterion[criterion] ?? null;
    const vb = b.metrics.byCriterion[criterion] ?? null;
    byCriterion[criterion] = {
      a: va,
      b: vb,
      delta: va !== null && vb !== null ? Number((vb - va).toFixed(3)) : null,
    };
  }

  const agents = new Set([...Object.keys(a.metrics.byAgent), ...Object.keys(b.metrics.byAgent)]);
  const byAgent: RunComparison['byAgent'] = {};
  for (const agent of agents) {
    const aa = a.metrics.byAgent[agent];
    const bb = b.metrics.byAgent[agent];
    byAgent[agent] = {
      overallDelta: aa && bb ? Number((bb.overall - aa.overall).toFixed(3)) : null,
      costDelta: aa && bb ? Number((bb.costUsd - aa.costUsd).toFixed(6)) : null,
      p95Delta: aa && bb ? Number((bb.latencyP95Ms - aa.latencyP95Ms).toFixed(1)) : null,
    };
  }

  const casesA = new Map(a.cases.map((c) => [c.id, c]));
  const closerToChanges: RunComparison['closerToChanges'] = [];
  for (const caseB of b.cases) {
    const caseA = casesA.get(caseB.id);
    if (caseA && caseA.closerTo !== caseB.closerTo) {
      closerToChanges.push({ id: caseB.id, from: caseA.closerTo, to: caseB.closerTo });
    }
  }

  return {
    runA: a.runId,
    runB: b.runId,
    byCriterion,
    byAgent,
    closerToChanges,
    overallDelta: Number((b.metrics.overall - a.metrics.overall).toFixed(3)),
    costDelta: Number((b.metrics.totalCostUsd - a.metrics.totalCostUsd).toFixed(6)),
  };
}

/** Percentil simples (p em [0,100]) sobre uma lista de números. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}
