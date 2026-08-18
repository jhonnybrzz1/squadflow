/**
 * Spec 008 / US3: `compare-eval-runs.ts` não pode morrer com stack trace no
 * caminho vazio — 0 runs é condição prevista (exit 0, mensagem em PT-BR).
 * Contrato: specs/008-correcoes-pos-qa-005-006-007/contracts/compare-eval-runs-contract.md
 */
import { describe, expect, it, vi } from 'vitest';

import { compareEvalRunsCli, type CompareCliDeps } from '../../scripts/compare-eval-runs';
import type { EvalRun } from '../../server/evaluation/eval-run-store';

function makeDeps(overrides: Partial<CompareCliDeps> = {}): {
  deps: CompareCliDeps;
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const deps: CompareCliDeps = {
    listRuns: () => [],
    resolveRunAlias: (alias) => alias,
    loadRun: () => {
      throw new Error('loadRun não deveria ser chamado neste teste');
    },
    compareRuns: () => {
      throw new Error('compareRuns não deveria ser chamado neste teste');
    },
    log: (m) => logs.push(m),
    logError: (m) => errors.push(m),
    ...overrides,
  };
  return { deps, logs, errors };
}

describe('compareEvalRunsCli — caminho vazio (spec 008 / US3)', () => {
  it('exit 0 e mensagem amigável PT-BR quando não há nenhum run', () => {
    const { deps, logs, errors } = makeDeps({ listRuns: () => [] });

    const exitCode = compareEvalRunsCli(['latest-1', 'latest'], deps);

    expect(exitCode).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('Nenhum run de avaliação encontrado');
    expect(output).toContain('npm run evaluate-agent');
    expect(output).not.toMatch(/at\s+\w+\s+\(/); // sem frames de stack
    expect(errors).toHaveLength(0);
  });

  it('exit 0 e orientação quando existe apenas 1 run (latest-1 impossível)', () => {
    const { deps, logs } = makeDeps({
      listRuns: () => [{ runId: 'run-unico', generatedAt: '2026-07-16T00:00:00Z' } as never],
    });

    const exitCode = compareEvalRunsCli(['latest-1', 'latest'], deps);

    expect(exitCode).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('Apenas 1 run encontrado');
    expect(output).toContain('são necessários 2 para comparar');
  });

  it('exit 1 com uso correto quando faltam argumentos', () => {
    const { deps, errors } = makeDeps();

    const exitCode = compareEvalRunsCli(['latest'], deps);

    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toContain('Uso:');
  });

  it('exit 1 com mensagem concisa (sem stack) em erro inesperado', () => {
    const { deps, errors } = makeDeps({
      listRuns: () => [{ runId: 'a' } as never, { runId: 'b' } as never],
      resolveRunAlias: () => {
        throw new Error('índice corrompido');
      },
    });

    const exitCode = compareEvalRunsCli(['latest-1', 'latest'], deps);

    expect(exitCode).toBe(1);
    const output = errors.join('\n');
    expect(output).toContain('Erro inesperado ao comparar runs: índice corrompido');
    expect(output).not.toMatch(/\n\s+at\s/); // nenhum frame de stack cru
  });

  it('continua comparando normalmente quando os runs existem', () => {
    const fakeRun = (id: string): EvalRun =>
      ({
        runId: id,
        generatedAt: '2026-07-16T00:00:00Z',
        gitCommit: 'abc1234',
        params: {} as never,
        metrics: { overall: 0.5, totalCostUsd: 0.01 } as never,
        cases: [],
        passed: true,
      }) as never;

    const compare = vi.fn(() => ({
      runA: 'a',
      runB: 'b',
      overallDelta: 0.1,
      costDelta: 0.001,
      byCriterion: {},
      byAgent: {},
      closerToChanges: [],
    }));

    const { deps, logs } = makeDeps({
      listRuns: () => [{ runId: 'a' } as never, { runId: 'b' } as never],
      resolveRunAlias: (alias) => (alias === 'latest' ? 'b' : 'a'),
      loadRun: (runId) => fakeRun(runId),
      compareRuns: compare as never,
    });

    const exitCode = compareEvalRunsCli(['latest-1', 'latest'], deps);

    expect(exitCode).toBe(0);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).toContain('=== Comparação de runs ===');
  });
});
