/**
 * Unit tests for server/services/product-manager-tools.ts
 *
 * Strategy:
 * - vi.resetModules() + dynamic re-import in each describe block so the
 *   module-level TOOLS_REGISTRY Map starts fresh and tools can be re-registered
 *   without conflicts across test suites.
 * - demandRepository and agentInterventionService are mocked at the top level.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks before any import
// ---------------------------------------------------------------------------

vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: {
    findAll: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock('../../server/services/agent-intervention-service', () => ({
  agentInterventionService: {
    getMonthlyMetrics: vi.fn(),
  },
}));

// Mock logger to suppress noise
vi.mock('../../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function importFresh() {
  const registry = await import('../../server/services/agent-tools-registry');
  const { registerProductManagerTools } =
    await import('../../server/services/product-manager-tools');
  const demandRepositoryModule = await import('../../server/repositories/demand-repository');
  const agentInterventionModule = await import('../../server/services/agent-intervention-service');
  return { registry, registerProductManagerTools, demandRepositoryModule, agentInterventionModule };
}

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

const mockDemand = {
  id: 1,
  title: 'Test demand',
  description: 'test description about feature implementation',
  type: 'feature',
  domain: 'padrao',
  status: 'completed',
  priority: 'medium',
  progress: 100,
  currentAgent: null,
  createdAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  documentState: null,
  requiresApproval: false,
  requiresHumanReview: false,
  refinementType: null,
  refinementInteractions: '[]',
  learningLog: '[]',
  prdUrl: null,
  tddUrl: null,
  tasksUrl: null,
  qualityGateStatus: 'passed',
  revisionNumber: 1,
};

// ==========================================================================
// Tool 1: search_similar_demands
// ==========================================================================

describe('search_similar_demands', () => {
  let registry: Awaited<ReturnType<typeof importFresh>>['registry'];
  let demandRepositoryModule: Awaited<ReturnType<typeof importFresh>>['demandRepositoryModule'];

  beforeEach(async () => {
    vi.resetModules();
    const imports = await importFresh();
    registry = imports.registry;
    demandRepositoryModule = imports.demandRepositoryModule;
    imports.registerProductManagerTools();
  });

  it('returns matching demands with relevanceScore when keywords match', async () => {
    vi.mocked(demandRepositoryModule.demandRepository.findAll).mockResolvedValue([
      mockDemand,
      { ...mockDemand, id: 2, title: 'Unrelated task', description: 'something else entirely' },
    ] as any);

    const result = await registry.executeTool('search_similar_demands', {
      keywords: 'feature implementation',
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('search_similar_demands');
    const data = result.data as any;
    expect(data.totalFound).toBeGreaterThan(0);
    expect(data.results[0].relevanceScore).toBeGreaterThan(0);
    // The demand matching "feature" and "implementation" should score highest
    expect(data.results[0].id).toBe(1);
  });

  it('returns totalFound: 0 when no demand matches the keywords', async () => {
    vi.mocked(demandRepositoryModule.demandRepository.findAll).mockResolvedValue([
      mockDemand,
    ] as any);

    const result = await registry.executeTool('search_similar_demands', {
      keywords: 'blockchain AI quantum',
    });

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.totalFound).toBe(0);
    expect(data.results).toHaveLength(0);
  });

  it('filters demands by domain when domain param is provided', async () => {
    const otherDomainDemand = {
      ...mockDemand,
      id: 2,
      domain: 'outro',
      title: 'feature other task',
    };
    vi.mocked(demandRepositoryModule.demandRepository.findAll).mockResolvedValue([
      mockDemand, // domain: 'padrao'
      otherDomainDemand, // domain: 'outro'
    ] as any);

    const result = await registry.executeTool('search_similar_demands', {
      keywords: 'feature',
      domain: 'padrao',
    });

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.results.every((r: any) => r.domain === 'padrao')).toBe(true);
  });

  it('filters demands by status when status param is provided', async () => {
    const processingDemand = {
      ...mockDemand,
      id: 2,
      status: 'processing',
      title: 'feature in progress',
    };
    vi.mocked(demandRepositoryModule.demandRepository.findAll).mockResolvedValue([
      mockDemand, // status: 'completed'
      processingDemand, // status: 'processing'
    ] as any);

    const result = await registry.executeTool('search_similar_demands', {
      keywords: 'feature',
      status: 'processing',
    });

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.results.every((r: any) => r.status === 'processing')).toBe(true);
  });

  it('respects limit param', async () => {
    const manyDemands = Array.from({ length: 20 }, (_, i) => ({
      ...mockDemand,
      id: i + 1,
      title: `feature task ${i}`,
    }));

    vi.mocked(demandRepositoryModule.demandRepository.findAll).mockResolvedValue(
      manyDemands as any,
    );

    const result = await registry.executeTool('search_similar_demands', {
      keywords: 'feature',
      limit: 5,
    });

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.results.length).toBeLessThanOrEqual(5);
  });

  it('returns ok:false when demandRepository.findAll throws', async () => {
    vi.mocked(demandRepositoryModule.demandRepository.findAll).mockRejectedValue(
      new Error('DB connection failed'),
    );

    const result = await registry.executeTool('search_similar_demands', {
      keywords: 'feature',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('DB connection failed');
    expect(result.source).toBe('search_similar_demands');
  });
});

// ==========================================================================
// Tool 2: get_demand_history
// ==========================================================================

describe('get_demand_history', () => {
  let registry: Awaited<ReturnType<typeof importFresh>>['registry'];
  let demandRepositoryModule: Awaited<ReturnType<typeof importFresh>>['demandRepositoryModule'];

  beforeEach(async () => {
    vi.resetModules();
    const imports = await importFresh();
    registry = imports.registry;
    demandRepositoryModule = imports.demandRepositoryModule;
    imports.registerProductManagerTools();
  });

  it('returns full demand history including parsed refinementInteractions', async () => {
    const interactions = [
      { step: 'clarification', message: 'What is the scope?' },
      { step: 'answer', message: 'Limited to auth module.' },
    ];
    vi.mocked(demandRepositoryModule.demandRepository.findById).mockResolvedValue({
      ...mockDemand,
      refinementInteractions: JSON.stringify(interactions),
      learningLog: JSON.stringify([{ lesson: 'keep it simple' }]),
    } as any);

    const result = await registry.executeTool('get_demand_history', { demandId: 1 });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('get_demand_history');
    const data = result.data as any;
    expect(data.id).toBe(1);
    expect(data.title).toBe('Test demand');
    expect(data.refinementInteractionsCount).toBe(2);
    expect(data.refinementInteractions).toHaveLength(2);
    expect(data.artifacts).toEqual({ prdUrl: null, tddUrl: null, tasksUrl: null });
    expect(data.qualityGateStatus).toBe('passed');
  });

  it('handles empty refinementInteractions array gracefully', async () => {
    vi.mocked(demandRepositoryModule.demandRepository.findById).mockResolvedValue(
      mockDemand as any,
    );

    const result = await registry.executeTool('get_demand_history', { demandId: 1 });

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.refinementInteractionsCount).toBe(0);
    expect(data.refinementInteractions).toEqual([]);
  });

  it('returns only last 10 refinementInteractions when more than 10 exist', async () => {
    const manyInteractions = Array.from({ length: 15 }, (_, i) => ({
      step: `step-${i}`,
      message: `msg ${i}`,
    }));

    vi.mocked(demandRepositoryModule.demandRepository.findById).mockResolvedValue({
      ...mockDemand,
      refinementInteractions: JSON.stringify(manyInteractions),
    } as any);

    const result = await registry.executeTool('get_demand_history', { demandId: 1 });

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.refinementInteractionsCount).toBe(15);
    expect(data.refinementInteractions).toHaveLength(10);
  });

  it('returns ok:false when demand is not found', async () => {
    vi.mocked(demandRepositoryModule.demandRepository.findById).mockResolvedValue(null as any);

    const result = await registry.executeTool('get_demand_history', { demandId: 999 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('999');
    expect(result.source).toBe('get_demand_history');
  });

  it('returns ok:false when repository throws an error', async () => {
    vi.mocked(demandRepositoryModule.demandRepository.findById).mockRejectedValue(
      new Error('Timeout'),
    );

    const result = await registry.executeTool('get_demand_history', { demandId: 1 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Timeout');
  });
});

// ==========================================================================
// Tool 3: get_approval_patterns
// ==========================================================================

describe('get_approval_patterns', () => {
  let registry: Awaited<ReturnType<typeof importFresh>>['registry'];
  let demandRepositoryModule: Awaited<ReturnType<typeof importFresh>>['demandRepositoryModule'];

  beforeEach(async () => {
    vi.resetModules();
    const imports = await importFresh();
    registry = imports.registry;
    demandRepositoryModule = imports.demandRepositoryModule;
    imports.registerProductManagerTools();
  });

  it('returns stats with byType, byDomain, successRate for completed demands', async () => {
    const errorDemand = { ...mockDemand, id: 2, status: 'error', type: 'bug', domain: 'outro' };
    const stoppedDemand = {
      ...mockDemand,
      id: 3,
      status: 'stopped',
      type: 'feature',
      domain: 'padrao',
    };

    vi.mocked(demandRepositoryModule.demandRepository.findAll).mockResolvedValue([
      mockDemand, // status: completed, type: feature, domain: padrao
      errorDemand, // status: error,     type: bug,     domain: outro
      stoppedDemand, // status: stopped,   type: feature, domain: padrao
    ] as any);

    const result = await registry.executeTool('get_approval_patterns', {});

    expect(result.ok).toBe(true);
    expect(result.source).toBe('get_approval_patterns');
    const data = result.data as any;
    expect(data.analyzed).toBe(3);
    expect(data.stats.total).toBe(3);
    expect(data.stats.completed).toBe(1);
    expect(data.stats.error).toBe(1);
    expect(data.stats.stopped).toBe(1);
    expect(data.stats.byType['feature']).toBeDefined();
    expect(data.stats.byType['feature'].total).toBe(2);
    expect(data.stats.byType['feature'].completed).toBe(1);
    expect(data.stats.byDomain['padrao']).toBeDefined();
    expect(typeof data.successRate).toBe('string');
    expect(data.successRate).toMatch(/%$/);
  });

  it('filters by domain when domain param is provided', async () => {
    const otherDomainDemand = {
      ...mockDemand,
      id: 2,
      domain: 'outro',
      status: 'completed',
    };

    vi.mocked(demandRepositoryModule.demandRepository.findAll).mockResolvedValue([
      mockDemand, // domain: padrao
      otherDomainDemand, // domain: outro
    ] as any);

    const result = await registry.executeTool('get_approval_patterns', { domain: 'padrao' });

    expect(result.ok).toBe(true);
    const data = result.data as any;
    // Only padrao demand should be analysed
    expect(data.analyzed).toBe(1);
    expect(data.stats.byDomain['padrao']).toBeDefined();
    expect(data.stats.byDomain['outro']).toBeUndefined();
  });

  it('returns successRate: N/A when no demands match filters', async () => {
    vi.mocked(demandRepositoryModule.demandRepository.findAll).mockResolvedValue([] as any);

    const result = await registry.executeTool('get_approval_patterns', {});

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.analyzed).toBe(0);
    expect(data.successRate).toBe('N/A');
  });

  it('returns ok:false when repository throws an error', async () => {
    vi.mocked(demandRepositoryModule.demandRepository.findAll).mockRejectedValue(
      new Error('Query failed'),
    );

    const result = await registry.executeTool('get_approval_patterns', {});

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Query failed');
  });

  it('includes high-revision insight when avgRevisions > 1.5', async () => {
    const highRevisionDemands = Array.from({ length: 3 }, (_, i) => ({
      ...mockDemand,
      id: i + 1,
      revisionNumber: 3,
    }));

    vi.mocked(demandRepositoryModule.demandRepository.findAll).mockResolvedValue(
      highRevisionDemands as any,
    );

    const result = await registry.executeTool('get_approval_patterns', {});

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.insights.some((i: string) => /revisões/i.test(i))).toBe(true);
  });
});

// ==========================================================================
// Tool 4: get_anti_overengineering_insights
// ==========================================================================

describe('get_anti_overengineering_insights', () => {
  let registry: Awaited<ReturnType<typeof importFresh>>['registry'];
  let agentInterventionModule: Awaited<ReturnType<typeof importFresh>>['agentInterventionModule'];

  beforeEach(async () => {
    vi.resetModules();
    const imports = await importFresh();
    registry = imports.registry;
    agentInterventionModule = imports.agentInterventionModule;
    imports.registerProductManagerTools();
  });

  it('returns insights with summary when interventions exist', async () => {
    vi.mocked(agentInterventionModule.agentInterventionService.getMonthlyMetrics).mockResolvedValue(
      {
        totalInterventions: 10,
        totalDiasEconomizados: 25,
        overridesCount: 2,
        interventionsByMonth: [{ month: '2024-01', interventions: 10, diasEconomizados: 25 }],
      } as any,
    );

    const result = await registry.executeTool('get_anti_overengineering_insights', {});

    expect(result.ok).toBe(true);
    expect(result.source).toBe('get_anti_overengineering_insights');
    const data = result.data as any;
    expect(data.available).toBe(true);
    expect(data.summary.totalInterventions).toBe(10);
    expect(data.summary.totalDiasEconomizados).toBe(25);
    expect(data.summary.overridesCount).toBe(2);
    expect(Array.isArray(data.monthlyBreakdown)).toBe(true);
    expect(Array.isArray(data.insights)).toBe(true);
    expect(data.insights.length).toBeGreaterThan(0);
  });

  it('returns available:false with message when no interventions exist', async () => {
    vi.mocked(agentInterventionModule.agentInterventionService.getMonthlyMetrics).mockResolvedValue(
      {
        totalInterventions: 0,
        totalDiasEconomizados: 0,
        overridesCount: 0,
        interventionsByMonth: [],
      } as any,
    );

    const result = await registry.executeTool('get_anti_overengineering_insights', {});

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.available).toBe(false);
    expect(data.message).toBeDefined();
    expect(data.recommendation).toBeDefined();
  });

  it('passes months param to getMonthlyMetrics (default 3)', async () => {
    const mockMetrics = {
      totalInterventions: 5,
      totalDiasEconomizados: 10,
      overridesCount: 0,
      interventionsByMonth: [],
    };

    vi.mocked(agentInterventionModule.agentInterventionService.getMonthlyMetrics).mockResolvedValue(
      mockMetrics as any,
    );

    await registry.executeTool('get_anti_overengineering_insights', {});

    expect(agentInterventionModule.agentInterventionService.getMonthlyMetrics).toHaveBeenCalledWith(
      3,
    );
  });

  it('passes explicit months param when provided', async () => {
    vi.mocked(agentInterventionModule.agentInterventionService.getMonthlyMetrics).mockResolvedValue(
      {
        totalInterventions: 5,
        totalDiasEconomizados: 10,
        overridesCount: 0,
        interventionsByMonth: [],
      } as any,
    );

    await registry.executeTool('get_anti_overengineering_insights', { months: 6 });

    expect(agentInterventionModule.agentInterventionService.getMonthlyMetrics).toHaveBeenCalledWith(
      6,
    );
  });

  it('includes high-override-rate insight when overrides > 30% of interventions', async () => {
    vi.mocked(agentInterventionModule.agentInterventionService.getMonthlyMetrics).mockResolvedValue(
      {
        totalInterventions: 10,
        totalDiasEconomizados: 15,
        overridesCount: 5, // 50% — above the 30% threshold
        interventionsByMonth: [],
      } as any,
    );

    const result = await registry.executeTool('get_anti_overengineering_insights', {});

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.insights.some((i: string) => /override/i.test(i))).toBe(true);
  });

  it('returns ok:false when service throws an error', async () => {
    vi.mocked(agentInterventionModule.agentInterventionService.getMonthlyMetrics).mockRejectedValue(
      new Error('Service unavailable'),
    );

    const result = await registry.executeTool('get_anti_overengineering_insights', {});

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Service unavailable');
    expect(result.source).toBe('get_anti_overengineering_insights');
  });
});

// ==========================================================================
// Tool 5: get_domain_stats
// ==========================================================================

describe('get_domain_stats', () => {
  let registry: Awaited<ReturnType<typeof importFresh>>['registry'];
  let demandRepositoryModule: Awaited<ReturnType<typeof importFresh>>['demandRepositoryModule'];

  beforeEach(async () => {
    vi.resetModules();
    const imports = await importFresh();
    registry = imports.registry;
    demandRepositoryModule = imports.demandRepositoryModule;
    imports.registerProductManagerTools();
  });

  it('returns statistics grouped by domain', async () => {
    const otherDomainDemand = {
      ...mockDemand,
      id: 2,
      domain: 'outro',
      status: 'completed',
      type: 'bug',
    };
    const processingDemand = {
      ...mockDemand,
      id: 3,
      domain: 'padrao',
      status: 'processing',
      progress: 50,
    };

    vi.mocked(demandRepositoryModule.demandRepository.findAll).mockResolvedValue([
      mockDemand, // domain: padrao, status: completed, progress: 100
      processingDemand, // domain: padrao, status: processing, progress: 50
      otherDomainDemand, // domain: outro,  status: completed, progress: 100
    ] as any);

    const result = await registry.executeTool('get_domain_stats', {});

    expect(result.ok).toBe(true);
    expect(result.source).toBe('get_domain_stats');
    const data = result.data as any;
    expect(data.totalDemands).toBe(3);
    expect(data.byDomain['padrao']).toBeDefined();
    expect(data.byDomain['padrao'].total).toBe(2);
    expect(data.byDomain['padrao'].completed).toBe(1);
    expect(data.byDomain['padrao'].inProgress).toBe(1);
    expect(data.byDomain['padrao'].avgProgress).toBe(75);
    expect(data.byDomain['outro']).toBeDefined();
    expect(data.byDomain['outro'].total).toBe(1);
    expect(data.byDomain['outro'].types['bug']).toBe(1);
  });

  it('returns empty byDomain and totalDemands: 0 when no demands exist', async () => {
    vi.mocked(demandRepositoryModule.demandRepository.findAll).mockResolvedValue([] as any);

    const result = await registry.executeTool('get_domain_stats', {});

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.totalDemands).toBe(0);
    expect(Object.keys(data.byDomain)).toHaveLength(0);
    expect(data.insights).toEqual([]);
  });

  it('includes high-error-rate insight for domain with >30% error rate', async () => {
    const errorDemands = Array.from({ length: 4 }, (_, i) => ({
      ...mockDemand,
      id: i + 10,
      status: 'error',
      domain: 'outro',
    }));
    const successDemand = { ...mockDemand, id: 99, status: 'completed', domain: 'outro' };

    vi.mocked(demandRepositoryModule.demandRepository.findAll).mockResolvedValue([
      ...errorDemands,
      successDemand,
    ] as any);

    const result = await registry.executeTool('get_domain_stats', {});

    expect(result.ok).toBe(true);
    const data = result.data as any;
    // outro: 4 errors out of 5 = 80% error rate → should trigger insight
    expect(data.insights.some((i: string) => /outro/i.test(i))).toBe(true);
  });

  it('groups demands with null domain under "padrao"', async () => {
    vi.mocked(demandRepositoryModule.demandRepository.findAll).mockResolvedValue([
      { ...mockDemand, domain: null },
    ] as any);

    const result = await registry.executeTool('get_domain_stats', {});

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.byDomain['padrao']).toBeDefined();
    expect(data.byDomain['padrao'].total).toBe(1);
  });

  it('returns ok:false when repository throws an error', async () => {
    vi.mocked(demandRepositoryModule.demandRepository.findAll).mockRejectedValue(
      new Error('DB error'),
    );

    const result = await registry.executeTool('get_domain_stats', {});

    expect(result.ok).toBe(false);
    expect(result.error).toContain('DB error');
    expect(result.source).toBe('get_domain_stats');
  });
});
