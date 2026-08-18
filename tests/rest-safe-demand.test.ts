import { describe, it, expect } from 'vitest';
import { toRestSafeDemand } from '../server/routes/shared';
import { REST_SAFE_REMOVED_FIELDS, type RestSafeDemand } from '../shared/demand-list';
import type { Demand } from '@shared/schema';

describe('toRestSafeDemand', () => {
  const baseDemand = {
    id: 1,
    title: 'T',
    description: 'D',
    type: 'melhoria',
    priority: 'alta',
    status: 'processing',
    progress: 0,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    chatMessages: [],
  } as unknown as Demand;

  it('removes REST_SAFE_REMOVED_FIELDS from the payload', () => {
    const demand = {
      ...baseDemand,
      classification: { criteria: { complexity: 50 } },
      orchestration: { plan: {} },
      reviewSnapshotId: 'snap',
      approvedSnapshotId: 'snap',
      approvedSnapshotHash: 'hash',
      finalSnapshotId: 'final',
      finalizedFromHash: 'hash',
      approvalSessionId: 'session',
      approvedAt: new Date(),
      approvedBy: 'po',
      rejectedAt: new Date(),
      rejectionReason: 'reason',
      returnedToDraftAt: new Date(),
      overrideJustification: 'justification',
      overrideBy: 'po',
      maxEffortOverrideDias: 10,
      maxEffortOverrideBy: 'po',
      maxEffortOverrideJustification: 'just',
      runId: 'run',
      promptTokens: 100,
      completionTokens: 50,
      custoEstimado: 0.1,
      learningLog: ['log'],
      qaEvidence: 'evidence',
      skillRawUrl: 'https://skill.sh',
      originalDescription: 'original',
      finalDocHash: 'hash',
    } as unknown as Demand;

    const result = toRestSafeDemand(demand);

    for (const field of REST_SAFE_REMOVED_FIELDS) {
      expect(result).not.toHaveProperty(field);
    }

    // Preserved fields
    expect(result).toHaveProperty('id', 1);
    expect(result).toHaveProperty('title', 'T');
    expect(result).toHaveProperty('description', 'D');
    expect(result).toHaveProperty('classification');
    expect(result).toHaveProperty('orchestration');
  });

  it('type-level: RestSafeDemand does not have removed fields', () => {
    const result: RestSafeDemand = toRestSafeDemand(baseDemand);

    // @ts-expect-error -- reviewSnapshotId is removed from RestSafeDemand
    void result.reviewSnapshotId;
    // @ts-expect-error -- learningLog is removed from RestSafeDemand
    void result.learningLog;
    // @ts-expect-error -- originalDescription is removed from RestSafeDemand
    void result.originalDescription;

    expect(result).toBeTruthy();
  });
});
