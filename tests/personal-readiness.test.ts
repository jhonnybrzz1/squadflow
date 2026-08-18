import { describe, expect, it } from 'vitest';
import { demandClassifier } from '../server/cognitive-core/demand-classifier';
import type { Demand } from '@shared/schema';

function createDemand(overrides: Partial<Demand>): Demand {
  return {
    id: 1,
    title: 'Melhorar criacao de demandas',
    description:
      'Como usuario builder, quero melhorar o formulario para reduzir retrabalho e medir quando uma demanda esta pronta. Nao fazer colaboracao multiusuario nesta versao. Criterio de aceite: mostrar status e perguntas abertas.',
    type: 'melhoria',
    priority: 'media',
    refinementType: 'technical',
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
    ...overrides,
  };
}

describe('personal readiness classification', () => {
  it('marks clear personal-product demands as ready', async () => {
    const classification = await demandClassifier.classifyDemand(createDemand({}));

    expect(classification.personalReadiness.level).toBe('ready');
    expect(classification.personalReadiness.score).toBeGreaterThanOrEqual(75);
    expect(classification.personalReadiness.recommendation).toContain('PRD');
  });

  it('marks vague demands as needing refinement', async () => {
    const classification = await demandClassifier.classifyDemand(
      createDemand({
        title: 'Fazer algo melhor',
        description: 'Melhorar isso talvez de algum jeito.',
        priority: 'baixa',
      }),
    );

    expect(classification.personalReadiness.level).not.toBe('ready');
    expect(classification.personalReadiness.nextQuestions.length).toBeGreaterThan(0);
  });
});
