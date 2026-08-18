/* eslint-disable no-restricted-syntax -- test fixtures use agent role strings to keep test data self-contained. */

import { describe, expect, it } from 'vitest';
import { toDemandListItem } from '../server/routes/demand-presenter';
import type { Demand } from '@shared/schema';

describe('toDemandListItem', () => {
  it('removes chatMessages from list payload and keeps counters', () => {
    const demand = {
      id: 1,
      title: 'Payload enxuto',
      description: 'Remover mensagens da listagem',
      type: 'melhoria',
      priority: 'alta',
      status: 'processing',
      progress: 50,
      chatMessages: [
        {
          id: '1',
          agent: 'product_owner',
          message: 'ok',
          timestamp: new Date().toISOString(),
          type: 'completed',
        },
        {
          id: '2',
          agent: 'tech_lead',
          message: 'processando',
          timestamp: new Date().toISOString(),
          type: 'processing',
        },
      ],
    } as Demand;

    const result = toDemandListItem(demand);

    expect(result).not.toHaveProperty('chatMessages');
    expect(result.chatMessageCount).toBe(2);
    expect(result.completedMessageCount).toBe(1);
  });

  it('excludes heavy blobs from the list payload', () => {
    const demand = {
      id: 2,
      title: 'Sem blobs',
      description: 'Blobs internos não devem ir para a lista',
      type: 'melhoria',
      priority: 'media',
      status: 'processing',
      progress: 0,
      chatMessages: [],
      classification: { criteria: { complexity: 50 } },
      orchestration: { plan: { agentExecutionOrder: ['product_owner', 'tech_lead'] } },
      typeAdherence: { isAdherent: true, score: 100 },
      refinementInteractions: [{ id: '1', question: 'q', answer: 'a' }],
      sectionChecklist: { prd: true },
      coverageAnalysis: { score: 80 },
      documentVersions: { prd: { version: 1, hash: 'abc' } },
      learningLog: ['log'],
      qaEvidence: 'evidence',
      originalDescription: 'original',
      maxEffortOverrideDias: 10,
      maxEffortOverrideBy: 'po',
      maxEffortOverrideJustification: 'justification',
    } as unknown as Demand;

    const result = toDemandListItem(demand);

    expect(result).not.toHaveProperty('classification');
    expect(result).not.toHaveProperty('orchestration');
    expect(result).not.toHaveProperty('refinementInteractions');
    expect(result).not.toHaveProperty('sectionChecklist');
    expect(result).not.toHaveProperty('coverageAnalysis');
    expect(result).not.toHaveProperty('documentVersions');
    expect(result).not.toHaveProperty('learningLog');
    expect(result).not.toHaveProperty('qaEvidence');
    expect(result).not.toHaveProperty('originalDescription');
    expect(result).not.toHaveProperty('maxEffortOverrideDias');
    expect(result).not.toHaveProperty('maxEffortOverrideBy');
    expect(result).not.toHaveProperty('maxEffortOverrideJustification');
    expect(result.typeAdherence).toEqual({ isAdherent: true, score: 100 });
    expect(result.executionPlanSize).toBe(2);
  });

  it('defaults executionPlanSize to 7 when orchestration has no plan', () => {
    const demand = {
      id: 3,
      title: 'Default plan size',
      description: 'No orchestration plan',
      type: 'melhoria',
      priority: 'baixa',
      status: 'processing',
      progress: 0,
      chatMessages: [],
    } as Demand;

    const result = toDemandListItem(demand);

    expect(result.executionPlanSize).toBe(7);
  });
});
