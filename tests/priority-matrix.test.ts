/**
 * Spec 022 — matriz de priorização com esforço linear (sem buckets),
 * fallback logado e escala de valor recalibrada (55/75/85/100, threshold 60).
 * Reescrito sem tokenOptimization (o código de produção nunca leu esse campo).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Demand } from '../shared/schema';
import {
  buildPriorityMatrix,
  calculateDemandEffortScore,
  calculateDemandValueScore,
  classifyDemandForPriorityMatrix,
} from '../shared/priority-matrix';

function createDemand(overrides: Partial<Demand>): Demand {
  return {
    id: 1,
    title: 'Demanda',
    description: 'Descrição objetiva da demanda.',
    type: 'melhoria',
    priority: 'media',
    refinementType: 'business',
    status: 'processing',
    progress: 0,
    chatMessages: [],
    prdUrl: null,
    tasksUrl: null,
    classification: null,
    orchestration: null,
    currentAgent: null,
    errorMessage: null,
    validationNotes: null,
    typeAdherence: null,
    completedAt: null,
    requiresApproval: false,
    requiresHumanReview: false,
    documentState: 'DRAFT',
    reviewSnapshotId: null,
    approvedSnapshotId: null,
    approvedSnapshotHash: null,
    finalSnapshotId: null,
    finalizedFromHash: null,
    approvalSessionId: null,
    revisionNumber: 0,
    reviewRequestedAt: null,
    approvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    domain: 'padrao',
    executionId: null,
    executionConfig: null,
    qualityPassed: null,
    missingSections: null,
    fallbackUsed: false,
    fallbackReason: null,
    ...overrides,
  } as Demand;
}

function withComplexity(complexity: number, overrides: Partial<Demand> = {}): Demand {
  return createDemand({
    classification: { criteria: { complexity } } as Demand['classification'],
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('effortScore linear via classification.criteria.complexity (US1, FR-002)', () => {
  it.each([0, 30, 60, 80, 100])('complexity %i mapeia linearmente', (complexity) => {
    expect(calculateDemandEffortScore(withComplexity(complexity))).toBe(complexity);
  });

  it('granularidade restaurada: 59 e 61 geram scores distintos, sem salto de bucket (SC-001)', () => {
    const a = calculateDemandEffortScore(withComplexity(59));
    const b = calculateDemandEffortScore(withComplexity(61));
    expect(a).toBe(59);
    expect(b).toBe(61);
    expect(b - a).toBe(2);
  });

  it('clampa complexity malformada para [0,100]', () => {
    expect(calculateDemandEffortScore(withComplexity(-5))).toBe(0);
    expect(calculateDemandEffortScore(withComplexity(150))).toBe(100);
  });

  it('não emite warn de fallback quando há classification', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    calculateDemandEffortScore(withComplexity(42));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('fallback sem classification (US2, FR-003)', () => {
  it('descrição vazia contribui 0: score = maxEffortDays normalizado', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // melhoria → maxEffortDays 7 → base 56; descrição 0 chars → +0
    const score = calculateDemandEffortScore(createDemand({ description: '' }));
    expect(score).toBe(56);
  });

  it('descrição de 500 chars atinge exatamente o teto de +15', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const score = calculateDemandEffortScore(createDemand({ description: 'x'.repeat(500) }));
    expect(score).toBe(56 + 15);
  });

  it('descrição gigante não passa do teto (não distorce a matriz)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s500 = calculateDemandEffortScore(createDemand({ description: 'x'.repeat(500) }));
    const s5000 = calculateDemandEffortScore(createDemand({ description: 'x'.repeat(5000) }));
    expect(s5000).toBe(s500);
  });

  it('emite console.warn contendo o ID da demanda (T2-b)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    calculateDemandEffortScore(createDemand({ id: 77, description: '' }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(' ')).toContain('demanda 77');
  });

  it('ausência de classification não quebra a matriz (T4-d)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const matrix = buildPriorityMatrix([createDemand({ classification: null })]);
    const total = Object.values(matrix).reduce((n, items) => n + items.length, 0);
    expect(total).toBe(1);
    expect(Object.keys(matrix)).toEqual([
      'do_first',
      'plan_strategically',
      'do_later',
      'avoid_or_split',
    ]);
  });
});

describe('escala de valor e quadrantes desbloqueados (US3, FR-004/FR-005)', () => {
  it('escala base: baixa=55, média=75, alta=85, crítica=100 (tipo sem boost)', () => {
    for (const [priority, expected] of [
      ['baixa', 55],
      ['media', 75],
      ['alta', 85],
      ['critica', 100],
    ] as const) {
      expect(
        calculateDemandValueScore(createDemand({ priority, type: 'analise_exploratoria' })),
      ).toBe(expected);
    }
  });

  it('média com esforço ≤ 60 alcança plan_strategically ou superior (T3-c)', () => {
    const atThreshold = classifyDemandForPriorityMatrix(
      withComplexity(60, { priority: 'media', type: 'analise_exploratoria' }),
    );
    expect(atThreshold.quadrant).toBe('plan_strategically');

    const belowThreshold = classifyDemandForPriorityMatrix(
      withComplexity(30, { priority: 'media', type: 'analise_exploratoria' }),
    );
    expect(belowThreshold.quadrant).toBe('do_first');
  });

  it('baixa com esforço < 60 alcança ao menos do_later (T3-d)', () => {
    const item = classifyDemandForPriorityMatrix(
      withComplexity(30, { priority: 'baixa', type: 'analise_exploratoria' }),
    );
    expect(['do_later', 'do_first', 'plan_strategically']).toContain(item.quadrant);
    expect(item.quadrant).not.toBe('avoid_or_split');
  });

  it('fronteiras determinísticas: valor 60 é alto valor; esforço 60 é alto esforço', () => {
    // baixa (55) + boost de melhoria (+5) = 60 → alto valor exato
    const boundaryValue = classifyDemandForPriorityMatrix(
      withComplexity(10, { priority: 'baixa', type: 'melhoria' }),
    );
    expect(boundaryValue.valueScore).toBe(60);
    expect(boundaryValue.quadrant).toBe('do_first');

    const boundaryEffort = classifyDemandForPriorityMatrix(
      withComplexity(60, { priority: 'critica', type: 'analise_exploratoria' }),
    );
    expect(boundaryEffort.quadrant).toBe('plan_strategically');
  });

  it('bug crítico de baixo esforço continua do_first (regressão de comportamento)', () => {
    const item = classifyDemandForPriorityMatrix(
      withComplexity(20, { type: 'bug', priority: 'critica' }),
    );
    expect(item.quadrant).toBe('do_first');
  });

  it('contrato inalterado: PriorityMatrixItem expõe demand/quadrant/valueScore/effortScore/rationale (FR-008)', () => {
    const item = classifyDemandForPriorityMatrix(withComplexity(50));
    expect(Object.keys(item).sort()).toEqual(
      ['demand', 'effortScore', 'quadrant', 'rationale', 'valueScore'].sort(),
    );
    expect(typeof item.rationale).toBe('string');
  });
});
