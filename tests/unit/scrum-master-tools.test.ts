import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: {
    findAll: vi.fn(),
    findById: vi.fn(),
  },
}));

import * as demandRepoModule from '../../server/repositories/demand-repository';
import { registerScrumMasterTools } from '../../server/services/scrum-master-tools';
import * as registry from '../../server/services/agent-tools-registry';

const mockedDemands = vi.mocked(demandRepoModule.demandRepository);

const makeDate = (daysAgo: number) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
};

const makeDemand = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  title: 'Test demand',
  description: 'test description',
  type: 'feature',
  domain: 'padrao',
  status: 'completed',
  priority: 'medium',
  progress: 100,
  currentAgent: 'tech_lead',
  createdAt: makeDate(5),
  completedAt: makeDate(3),
  documentState: null,
  requiresApproval: false,
  requiresHumanReview: false,
  refinementType: null,
  prdUrl: null,
  tddUrl: null,
  tasksUrl: null,
  qualityGateStatus: 'passed',
  revisionNumber: 1,
  ...overrides,
});

beforeAll(() => {
  registerScrumMasterTools();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('scrum-master-tools', () => {
  // -------------------------------------------------------
  // Tool: get_execution_stats
  // -------------------------------------------------------
  describe('get_execution_stats', () => {
    it('retorna estatísticas de execução para demandas recentes', async () => {
      mockedDemands.findAll.mockResolvedValue([
        makeDemand({
          id: 1,
          status: 'completed',
          createdAt: makeDate(10),
          completedAt: makeDate(8),
          priority: 'high',
        }),
        makeDemand({
          id: 2,
          status: 'completed',
          createdAt: makeDate(5),
          completedAt: makeDate(3),
          priority: 'medium',
        }),
        makeDemand({ id: 3, status: 'error', createdAt: makeDate(2), priority: 'low' }),
        makeDemand({ id: 4, status: 'processing', createdAt: makeDate(1), priority: 'medium' }),
      ] as never);

      const result = await registry.executeTool('get_execution_stats', { days: 30 });
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.totalDemands).toBe(4);
      expect(data.completed).toBe(2);
      expect(data.error).toBe(1);
      expect(data.inProgress).toBe(1);
      expect(typeof data.avgCompletionHours).toBe('string');
      expect(typeof data.throughputPerWeek).toBe('string');
      expect(data).toHaveProperty('byType');
      expect(data).toHaveProperty('byPriority');
    });

    it('usa 30 dias como default quando days não é passado', async () => {
      mockedDemands.findAll.mockResolvedValue([
        makeDemand({ id: 1, createdAt: makeDate(10), completedAt: makeDate(8) }),
      ] as never);

      const result = await registry.executeTool('get_execution_stats', {});
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.period).toBe('30 dias');
    });

    it('retorna stats zeradas quando não há demandas no período', async () => {
      // Todas com data muito antiga
      mockedDemands.findAll.mockResolvedValue([
        makeDemand({ id: 1, createdAt: makeDate(100), completedAt: makeDate(90) }),
      ] as never);

      const result = await registry.executeTool('get_execution_stats', { days: 7 });
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.totalDemands).toBe(0);
    });
  });

  // -------------------------------------------------------
  // Tool: get_demand_metrics
  // -------------------------------------------------------
  describe('get_demand_metrics', () => {
    it('retorna métricas gerais quando sem filtro', async () => {
      mockedDemands.findAll.mockResolvedValue([
        makeDemand({ id: 1, type: 'feature', domain: 'padrao', status: 'completed' }),
        makeDemand({ id: 2, type: 'bug', domain: 'outro', status: 'error' }),
        makeDemand({ id: 3, type: 'feature', domain: 'geral', status: 'completed' }),
      ] as never);

      const result = await registry.executeTool('get_demand_metrics', {});
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      // get_demand_metrics retorna total diretamente (não em metrics wrapper)
      expect(data.total).toBe(3);
      expect(data).toHaveProperty('byStatus');
      expect(data).toHaveProperty('inProgressStats');
      expect(data).toHaveProperty('blockedStats');
    });

    it('filtra por tipo quando type é passado', async () => {
      mockedDemands.findAll.mockResolvedValue([
        makeDemand({ id: 1, type: 'feature', status: 'completed' }),
        makeDemand({ id: 2, type: 'bug', status: 'completed' }),
        makeDemand({ id: 3, type: 'feature', status: 'error' }),
      ] as never);

      const result = await registry.executeTool('get_demand_metrics', { type: 'feature' });
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.total).toBe(2);
    });

    it('filtra por domínio quando domain é passado', async () => {
      mockedDemands.findAll.mockResolvedValue([
        makeDemand({ id: 1, domain: 'outro', status: 'completed' }),
        makeDemand({ id: 2, domain: 'padrao', status: 'completed' }),
      ] as never);

      const result = await registry.executeTool('get_demand_metrics', { domain: 'padrao' });
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.total).toBe(1);
    });
  });

  // -------------------------------------------------------
  // Tool: get_agent_performance
  // -------------------------------------------------------
  describe('get_agent_performance', () => {
    it('retorna distribuição de demandas por agente', async () => {
      mockedDemands.findAll.mockResolvedValue([
        makeDemand({ id: 1, status: 'completed', currentAgent: 'tech_lead' }),
        makeDemand({ id: 2, status: 'completed', currentAgent: 'tech_lead' }),
        makeDemand({ id: 3, status: 'error', currentAgent: 'product_manager' }),
        makeDemand({ id: 4, status: 'processing', currentAgent: 'qa' }),
      ] as never);

      const result = await registry.executeTool('get_agent_performance', {});
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      const completed = data.completedByAgent as Record<string, number>;
      expect(completed['tech_lead']).toBe(2);
      const errors = data.errorByAgent as Record<string, number>;
      expect(errors['product_manager']).toBe(1);
      const inProgress = data.inProgressByAgent as Record<string, number>;
      expect(inProgress['qa']).toBe(1);
    });

    it('identifica gargalos quando agente tem >3 demandas em processamento', async () => {
      const processing = [1, 2, 3, 4].map((id) =>
        makeDemand({ id, status: 'processing', currentAgent: 'tech_lead' }),
      );
      mockedDemands.findAll.mockResolvedValue(processing as never);

      const result = await registry.executeTool('get_agent_performance', {});
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      const bottlenecks = data.bottlenecks as Array<{ agent: string; count: number }>;
      expect(bottlenecks.some((b) => b.agent === 'tech_lead')).toBe(true);
    });

    it('retorna dados zerados para banco vazio', async () => {
      mockedDemands.findAll.mockResolvedValue([] as never);

      const result = await registry.executeTool('get_agent_performance', {});
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.bottlenecks).toEqual([]);
      expect(data.errorProneAgents).toEqual([]);
    });
  });

  // -------------------------------------------------------
  // Tool: get_completion_times
  // -------------------------------------------------------
  describe('get_completion_times', () => {
    it('calcula tempos de conclusão (avg, median, p90)', async () => {
      // 3 demandas completadas com tempos diferentes
      const now = Date.now();
      const demands = [
        makeDemand({
          id: 1,
          status: 'completed',
          createdAt: new Date(now - 10 * 3600_000).toISOString(),
          completedAt: new Date(now).toISOString(),
          type: 'feature',
        }),
        makeDemand({
          id: 2,
          status: 'completed',
          createdAt: new Date(now - 20 * 3600_000).toISOString(),
          completedAt: new Date(now).toISOString(),
          type: 'feature',
        }),
        makeDemand({
          id: 3,
          status: 'completed',
          createdAt: new Date(now - 5 * 3600_000).toISOString(),
          completedAt: new Date(now).toISOString(),
          type: 'bug',
        }),
      ];
      mockedDemands.findAll.mockResolvedValue(demands as never);

      const result = await registry.executeTool('get_completion_times', {});
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.analyzed).toBe(3);
      expect(data).toHaveProperty('stats');
      const stats = data.stats as Record<string, unknown>;
      expect(typeof stats.avgHours).toBe('string');
      expect(typeof stats.p90Hours).toBe('string');
      expect(data).toHaveProperty('estimationGuide');
    });

    it('filtra por tipo quando type é passado', async () => {
      const now = Date.now();
      mockedDemands.findAll.mockResolvedValue([
        makeDemand({
          id: 1,
          status: 'completed',
          type: 'feature',
          createdAt: new Date(now - 5 * 3600_000).toISOString(),
          completedAt: new Date(now).toISOString(),
        }),
        makeDemand({
          id: 2,
          status: 'completed',
          type: 'bug',
          createdAt: new Date(now - 10 * 3600_000).toISOString(),
          completedAt: new Date(now).toISOString(),
        }),
      ] as never);

      const result = await registry.executeTool('get_completion_times', { type: 'feature' });
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.analyzed).toBe(1);
    });

    it('retorna mensagem quando não há demandas completadas', async () => {
      mockedDemands.findAll.mockResolvedValue([makeDemand({ status: 'processing' })] as never);

      const result = await registry.executeTool('get_completion_times', {});
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      // Implementação retorna { message } quando lista é vazia
      expect(data).toHaveProperty('message');
      expect(data.message).toContain('Nenhuma demanda completada');
    });
  });
});
