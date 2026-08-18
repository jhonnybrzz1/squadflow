import { describe, it, expect } from 'vitest';
import {
  loadAgentsBaseline,
  buildRunFromCases,
  computeConcordance,
  validateDatasetCoverage,
  RUBRICS,
  AGENT_FILES,
} from '../../server/evaluation/evaluate-agent';
import {
  structuredFewShotExampleSchema,
  type StructuredFewShotExample,
} from '../../server/services/few-shot-bank';
import type { EvalCaseResult } from '../../server/evaluation/eval-run-store';

function makeCaseResult(overrides: Partial<EvalCaseResult> = {}): EvalCaseResult {
  return {
    id: 'qa-1',
    agent: 'qa',
    scores: { cobertura_cenarios: 4, criterios_verificaveis: 5, evidencias_reproduziveis: 4 },
    avgScore: 4.33,
    closerTo: 'valid',
    rationale: 'ok',
    agentCall: {
      model: 'm',
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0.001,
      durationMs: 100,
    },
    judgeCall: { model: 'j', promptTokens: 1, completionTokens: 1, costUsd: 0.001, durationMs: 50 },
    output: 'saida',
    ...overrides,
  };
}

function makeDatasetCase(id: string, split: 'train' | 'holdout'): StructuredFewShotExample {
  return structuredFewShotExampleSchema.parse({
    id,
    agent: 'qa',
    demand: { title: 'T', description: 'D' },
    validOutput: 'v',
    split,
  });
}

const baseline = { minOverall: 4, requireCloserToValid: true, minHoldoutPerAgent: 2 };

function buildOptions(dataset: StructuredFewShotExample[], deviations: string[] = []) {
  return {
    mode: 'full' as const,
    deviations,
    baseline,
    dataset,
    judgeModel: 'deepseek/deepseek-v4-pro',
    agentConfigs: {
      qa: { model: 'openai/gpt-x', temperature: 0.2, max_tokens: 4000, system_prompt: 'p' },
    },
    judgeConcordance: 'unmeasured' as const,
  };
}

describe('gate via baseline (FR-009) e paridade (US2)', () => {
  it('loadAgentsBaseline lê a seção agents de docs/evaluation-baseline.json', () => {
    const loaded = loadAgentsBaseline();
    expect(loaded.minOverall).toBe(4);
    expect(loaded.requireCloserToValid).toBe(true);
    expect(loaded.minHoldoutPerAgent).toBe(5);
  });

  it('baseline ausente/ilegível cai nos defaults sem lançar', () => {
    const loaded = loadAgentsBaseline('/nonexistent/baseline.json');
    expect(loaded.minOverall).toBe(4);
  });

  it('run reprova quando overall < minOverall com holdout suficiente', () => {
    const dataset = [makeDatasetCase('h1', 'holdout'), makeDatasetCase('h2', 'holdout')];
    const run = buildRunFromCases(
      [makeCaseResult({ avgScore: 3.0 }), makeCaseResult({ id: 'qa-2', avgScore: 3.2 })],
      buildOptions(dataset),
    );
    expect(run.passed).toBe(false);
    expect(run.inconclusiveAgents).toEqual([]);
  });

  it('run reprova com closerTo rejected quando requireCloserToValid', () => {
    const dataset = [makeDatasetCase('h1', 'holdout'), makeDatasetCase('h2', 'holdout')];
    const run = buildRunFromCases(
      [makeCaseResult({ avgScore: 4.8, closerTo: 'rejected' })],
      buildOptions(dataset),
    );
    expect(run.passed).toBe(false);
  });

  it('agente com holdout abaixo do piso é inconclusivo e não reprova o gate (FR-010)', () => {
    const dataset = [makeDatasetCase('h1', 'holdout')]; // 1 < piso 2
    const run = buildRunFromCases([makeCaseResult({ avgScore: 1.0 })], buildOptions(dataset));
    expect(run.inconclusiveAgents).toEqual(['qa']);
    expect(run.metrics.byAgent.qa.inconclusive).toBe(true);
    expect(run.passed).toBe(true); // declarado, não reprovado
  });

  it('params espelham o YAML e desvios são registrados (SC-002)', () => {
    const dataset = [makeDatasetCase('h1', 'holdout'), makeDatasetCase('h2', 'holdout')];
    const run = buildRunFromCases(
      [makeCaseResult()],
      buildOptions(dataset, ['cache:false', '--max-tokens-cap:2000']),
    );
    expect(run.params.maxTokens.qa).toBe(4000);
    expect(run.params.temperature.qa).toBe(0.2);
    expect(run.params.agentModels.qa).toBe('openai/gpt-x');
    expect(run.params.deviations).toContain('--max-tokens-cap:2000');
    expect(run.params.datasetSize.qa).toEqual({ train: 0, holdout: 2 });
  });

  it('registra viés juiz×agente da mesma família (sameProviderJudge)', () => {
    const dataset = [makeDatasetCase('h1', 'holdout'), makeDatasetCase('h2', 'holdout')];
    const options = buildOptions(dataset);
    options.agentConfigs.qa.model = 'deepseek/deepseek-v3';
    const run = buildRunFromCases([makeCaseResult()], options);
    expect(run.params.sameProviderJudge).toContain('qa');
  });
});

describe('custo e latência (US4/SC-004)', () => {
  it('separa custo agente × juiz e agrega p50/p95 por agente', () => {
    const dataset = [makeDatasetCase('h1', 'holdout'), makeDatasetCase('h2', 'holdout')];
    const cases = [
      makeCaseResult({
        id: 'qa-1',
        agentCall: {
          model: 'm',
          promptTokens: 100,
          completionTokens: 50,
          costUsd: 0.01,
          durationMs: 1000,
        },
        judgeCall: {
          model: 'j',
          promptTokens: 200,
          completionTokens: 20,
          costUsd: 0.002,
          durationMs: 300,
        },
      }),
      makeCaseResult({
        id: 'qa-2',
        agentCall: {
          model: 'm',
          promptTokens: 100,
          completionTokens: 50,
          costUsd: 0.02,
          durationMs: 2000,
        },
        judgeCall: {
          model: 'j',
          promptTokens: 200,
          completionTokens: 20,
          costUsd: 0.003,
          durationMs: 400,
        },
      }),
    ];
    const run = buildRunFromCases(cases, buildOptions(dataset));
    expect(run.metrics.totalCostUsd).toBeCloseTo(0.035);
    expect(run.metrics.byAgent.qa.costUsd).toBeCloseTo(0.035);
    expect(run.metrics.byAgent.qa.latencyP50Ms).toBe(1000);
    expect(run.metrics.byAgent.qa.latencyP95Ms).toBe(2000);
    expect(run.cases[0].agentCall.costUsd).not.toBe(run.cases[0].judgeCall.costUsd);
  });

  it('agrega média por critério de rubrica (FR-007)', () => {
    const dataset = [makeDatasetCase('h1', 'holdout'), makeDatasetCase('h2', 'holdout')];
    const cases = [
      makeCaseResult({
        scores: { cobertura_cenarios: 4, criterios_verificaveis: 2, evidencias_reproduziveis: 3 },
      }),
      makeCaseResult({
        id: 'qa-2',
        scores: { cobertura_cenarios: 5, criterios_verificaveis: 3, evidencias_reproduziveis: 3 },
      }),
    ];
    const run = buildRunFromCases(cases, buildOptions(dataset));
    expect(run.metrics.byCriterion.cobertura_cenarios).toBeCloseTo(4.5);
    expect(run.metrics.byCriterion.criterios_verificaveis).toBeCloseTo(2.5);
  });
});

describe('cobertura e concordância (US6/FR-012/FR-013)', () => {
  it('pm_innovation tem rubrica específica e mapeamento (US6)', () => {
    expect(RUBRICS.pm_innovation).toEqual([
      'originalidade_acionavel',
      'vinculo_dado_suporte',
      'custo_beneficio_inovacao',
    ]);
    expect(AGENT_FILES.pm_innovation).toBe('pm-innovation.yaml');
  });

  it('validateDatasetCoverage nomeia lacunas por agente sobre agents/ real', () => {
    const coverage = validateDatasetCoverage();
    const agents = coverage.map((entry) => entry.agent);
    expect(agents).toContain('pm_innovation');
    expect(agents).toContain('qa');
    const pmInnovation = coverage.find((entry) => entry.agent === 'pm_innovation');
    expect(pmInnovation?.gaps).toContain('sem-casos');
    // Nenhum agente com YAML real pode ficar sem rubrica após US6
    for (const entry of coverage) {
      expect(entry.gaps).not.toContain('sem-rubrica');
      expect(entry.gaps).not.toContain('sem-mapeamento');
    }
  });

  it('computeConcordance: |Δ| <= 1 conta como concordância; sem dados => unmeasured', () => {
    const cases = [
      makeCaseResult({
        scores: { cobertura_cenarios: 4, criterios_verificaveis: 2, evidencias_reproduziveis: 5 },
      }),
    ];
    expect(computeConcordance(cases, {})).toBe('unmeasured');
    const human = {
      'qa-1': { cobertura_cenarios: 5, criterios_verificaveis: 4, evidencias_reproduziveis: 5 },
    };
    // Δ = 1 (concorda), 2 (não), 0 (concorda) => 2/3
    expect(computeConcordance(cases, human)).toBeCloseTo(0.667, 2);
  });
});
