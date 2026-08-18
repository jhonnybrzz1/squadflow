import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  saveRun,
  loadRun,
  listRuns,
  resolveRunAlias,
  compareRuns,
  percentile,
  newRunId,
  type EvalRun,
} from '../../server/evaluation/eval-run-store';

function makeRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    runId: newRunId(),
    generatedAt: new Date().toISOString(),
    gitCommit: 'abc123',
    params: {
      agentModels: { qa: 'model-x' },
      judgeModel: 'judge-y',
      temperature: { qa: 0.3 },
      maxTokens: { qa: 4000 },
      datasetSize: { qa: { train: 1, holdout: 5 } },
      deviations: ['cache:false'],
      mode: 'full',
      sameProviderJudge: [],
    },
    metrics: {
      overall: 4.2,
      byCriterion: { cobertura_cenarios: 4.5, criterios_verificaveis: 3.9 },
      byAgent: {
        qa: {
          overall: 4.2,
          inconclusive: false,
          costUsd: 0.01,
          latencyP50Ms: 900,
          latencyP95Ms: 1500,
        },
      },
      totalCostUsd: 0.02,
    },
    cases: [
      {
        id: 'qa-1',
        agent: 'qa',
        scores: { cobertura_cenarios: 4, criterios_verificaveis: 4 },
        avgScore: 4,
        closerTo: 'valid',
        rationale: 'ok',
        agentCall: {
          model: 'model-x',
          promptTokens: 10,
          completionTokens: 20,
          costUsd: 0.005,
          durationMs: 900,
        },
        judgeCall: {
          model: 'judge-y',
          promptTokens: 30,
          completionTokens: 10,
          costUsd: 0.005,
          durationMs: 400,
        },
        output: 'saida',
      },
    ],
    passed: true,
    inconclusiveAgents: [],
    judgeConcordance: 'unmeasured',
    ...overrides,
  };
}

describe('eval-run-store (spec 006 / US3)', () => {
  it('round-trip save/load e índice append', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-runs-'));
    const runA = makeRun();
    const runB = makeRun();

    expect(saveRun(runA, dir)).toContain(runA.runId);
    expect(saveRun(runB, dir)).toContain(runB.runId);

    const loaded = loadRun(runA.runId, dir);
    expect(loaded.metrics.overall).toBe(4.2);

    const index = listRuns(dir);
    expect(index).toHaveLength(2);
    expect(index[0].runId).toBe(runA.runId);
    expect(resolveRunAlias('latest', dir)).toBe(runB.runId);
    expect(resolveRunAlias('latest-1', dir)).toBe(runA.runId);
  });

  it('falha de escrita não lança — registro é aditivo (FR-005)', () => {
    const run = makeRun();
    const impossibleDir = path.join(os.tmpdir(), 'eval-runs-file-as-dir');
    fs.writeFileSync(impossibleDir, 'not a dir');
    expect(() => saveRun(run, path.join(impossibleDir, 'sub'))).not.toThrow();
    expect(saveRun(run, path.join(impossibleDir, 'sub'))).toBeNull();
    fs.unlinkSync(impossibleDir);
  });

  it('compareRuns produz Δ por critério, agente e custo (FR-007/SC-003)', () => {
    const runA = makeRun();
    const runB = makeRun({
      metrics: {
        ...runA.metrics,
        overall: 4.5,
        byCriterion: { cobertura_cenarios: 5.0, criterios_verificaveis: 3.9 },
        byAgent: {
          qa: {
            overall: 4.5,
            inconclusive: false,
            costUsd: 0.02,
            latencyP50Ms: 800,
            latencyP95Ms: 1400,
          },
        },
        totalCostUsd: 0.04,
      },
      cases: [{ ...runA.cases[0], closerTo: 'rejected' }],
    });

    const diff = compareRuns(runA, runB);
    expect(diff.byCriterion.cobertura_cenarios.delta).toBeCloseTo(0.5);
    expect(diff.byCriterion.criterios_verificaveis.delta).toBeCloseTo(0);
    expect(diff.byAgent.qa.overallDelta).toBeCloseTo(0.3);
    expect(diff.byAgent.qa.costDelta).toBeCloseTo(0.01);
    expect(diff.overallDelta).toBeCloseTo(0.3);
    expect(diff.costDelta).toBeCloseTo(0.02);
    expect(diff.closerToChanges).toEqual([{ id: 'qa-1', from: 'valid', to: 'rejected' }]);
  });

  it('percentile p50/p95', () => {
    const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    expect(percentile(values, 50)).toBe(500);
    expect(percentile(values, 95)).toBe(1000);
    expect(percentile([], 95)).toBe(0);
  });
});
