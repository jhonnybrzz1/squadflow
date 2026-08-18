import { describe, it, expect, vi, beforeEach } from 'vitest';
import { progressiveRefinementService } from '../server/services/progressive-refinement';
import { aiUsageTracker } from '../server/services/ai-usage-tracker';
import { db } from '../server/db';
import { demandClassifier } from '../server/cognitive-core/demand-classifier';
import { agentOrchestrator } from '../server/cognitive-core/agent-orchestrator';

vi.mock('../server/db', () => ({
  isPostgres: false,
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(true),
    }),
  },
}));

vi.mock('../server/storage', () => ({
  storage: {
    getDemand: vi
      .fn()
      .mockResolvedValue({ id: 1, title: 'Test', description: 'Test', type: 'melhoria' }),
  },
}));

describe('Progressive Refinement (T2 & T3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies complexity, risk and recommends level (T2)', async () => {
    const demand = {
      id: 1,
      title: 'Simple Text Edit',
      description: 'Just change the label from A to B.',
      type: 'melhoria',
    } as any;
    const classification = await demandClassifier.classifyDemand(demand);

    expect(classification.progressiveRefinement).toBeDefined();
    // Simple text edit should be low complexity and low risk -> Level 1 or 2
    expect(
      ['1', '2'].includes(String(classification.progressiveRefinement?.recommendedLevel)),
    ).toBe(true);
  });

  it('enforces agent limits based on recommended level (T3)', async () => {
    const classificationLevel1 = {
      recommendedAgents: ['product_owner', 'scrum_master', 'qa', 'product_manager', 'tech_lead'],
      progressiveRefinement: { recommendedLevel: 1, complexity: 'low', risk: 'low', impact: 'low' },
      criteria: { complexity: 20 },
    } as any;

    const classificationLevel2 = {
      recommendedAgents: [
        'product_owner',
        'scrum_master',
        'qa',
        'product_manager',
        'tech_lead',
        'ux_designer',
      ],
      progressiveRefinement: {
        recommendedLevel: 2,
        complexity: 'medium',
        risk: 'medium',
        impact: 'medium',
      },
      criteria: { complexity: 50 },
    } as any;

    const agentsL1 = (agentOrchestrator as any).determineAgentExecutionOrder(classificationLevel1);
    // Level 1 should only have refinador and product_manager
    expect(agentsL1).toEqual(['product_owner', 'product_manager']);

    const agentsL2 = (agentOrchestrator as any).determineAgentExecutionOrder(classificationLevel2);
    // Level 2 should not have UX
    expect(agentsL2.includes('ux_designer')).toBe(false);
    expect(agentsL2.includes('product_owner')).toBe(true);
    expect(agentsL2.includes('qa')).toBe(true);
  });
});

describe('Progressive Refinement Telemetry (T1 & T5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aiUsageTracker.reset();
  });

  it('persists execution record with cost and tokens', async () => {
    // Add fake usage
    aiUsageTracker.record({
      timestamp: new Date().toISOString(),
      demandId: 99,
      operation: 'agent_interaction:refinador',
      model: 'gpt-4o-mini',
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      estimatedCostUsd: 0.05,
      cacheHit: false,
      estimatedTokensSaved: 0,
      estimatedCostSavedUsd: null,
      latencyMs: 1000,
    });

    await progressiveRefinementService.persistExecutionRecord({
      demandId: 99,
      executionId: 'exec-123',
      complexity: 'low',
      impact: 'low',
      risk: 'low',
      levelTriaged: 1,
      levelExecuted: 1,
    });

    expect(db.insert).toHaveBeenCalled();
  });
});
