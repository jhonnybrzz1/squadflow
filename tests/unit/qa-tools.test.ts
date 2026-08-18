import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../server/services/repo-service', () => ({
  repoService: {
    getRepoWithFiles: vi.fn(),
    getOrCreateRepo: vi.fn(),
  },
}));

vi.mock('../../server/services/human-feedback-service', () => ({
  humanFeedbackService: {
    getByDemandId: vi.fn(),
  },
}));

vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: {
    findAll: vi.fn(),
    findById: vi.fn(),
  },
}));

import * as repoServiceModule from '../../server/services/repo-service';
import * as humanFeedbackModule from '../../server/services/human-feedback-service';
import * as demandRepoModule from '../../server/repositories/demand-repository';
import { registerQATools } from '../../server/services/qa-tools';
import * as registry from '../../server/services/agent-tools-registry';

const mockedRepo = vi.mocked(repoServiceModule.repoService);
const mockedFeedback = vi.mocked(humanFeedbackModule.humanFeedbackService);
const mockedDemands = vi.mocked(demandRepoModule.demandRepository);

const makeRepo = (
  files: Array<{
    path: string;
    filename: string;
    language: string;
    content: string;
    size: number;
  }> = [],
) => ({
  files,
  fullName: 'owner/repo',
  description: null,
  language: 'TypeScript',
  size: 100,
  stars: 0,
  defaultBranch: 'main',
  lastCommit: null,
  lastCommitDate: null,
  briefing: null,
  briefingGeneratedAt: null,
});

const makeDemand = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  title: 'Test demand',
  description: 'test description',
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
  ...overrides,
});

beforeAll(() => {
  registerQATools();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('qa-tools', () => {
  // -------------------------------------------------------
  // Tool: search_test_files
  // -------------------------------------------------------
  describe('search_test_files', () => {
    it('retorna arquivos de teste encontrados no repositório', async () => {
      mockedRepo.getRepoWithFiles.mockResolvedValue(
        makeRepo([
          {
            path: 'tests/auth.test.ts',
            filename: 'auth.test.ts',
            language: 'ts',
            content: 'describe',
            size: 100,
          },
          {
            path: 'tests/api.spec.ts',
            filename: 'api.spec.ts',
            language: 'ts',
            content: 'it(',
            size: 80,
          },
          {
            path: 'src/service.ts',
            filename: 'service.ts',
            language: 'ts',
            content: 'export',
            size: 200,
          },
        ]),
      );

      const result = await registry.executeTool('search_test_files', {
        repoFullName: 'owner/repo',
      });
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.totalTestFiles).toBe(2);
      expect(data.totalFiles).toBe(3);
    });

    it('filtra por pattern adicional', async () => {
      mockedRepo.getRepoWithFiles.mockResolvedValue(
        makeRepo([
          {
            path: 'tests/auth.test.ts',
            filename: 'auth.test.ts',
            language: 'ts',
            content: '',
            size: 10,
          },
          {
            path: 'tests/user.test.ts',
            filename: 'user.test.ts',
            language: 'ts',
            content: '',
            size: 10,
          },
        ]),
      );

      const result = await registry.executeTool('search_test_files', {
        repoFullName: 'owner/repo',
        pattern: 'auth',
      });
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.totalTestFiles).toBe(1);
    });

    it('retorna erro para repoFullName inválido', async () => {
      const result = await registry.executeTool('search_test_files', { repoFullName: 'invalid' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Formato inválido');
    });

    it('retorna erro quando repositório não encontrado', async () => {
      mockedRepo.getRepoWithFiles.mockResolvedValue(null);
      const result = await registry.executeTool('search_test_files', {
        repoFullName: 'owner/repo',
      });
      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------
  // Tool: get_demand_feedback
  // -------------------------------------------------------
  describe('get_demand_feedback', () => {
    it('retorna feedback de demanda específica quando demandId é passado', async () => {
      mockedFeedback.getByDemandId.mockReturnValue([
        { feedbackType: 'like', feedbackText: 'Bom trabalho', demandId: 1 } as never,
      ]);

      const result = await registry.executeTool('get_demand_feedback', { demandId: 1 });
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.demandId).toBe(1);
      expect(data.totalFeedbacks).toBe(1);
    });

    it('retorna feedbacks agregados quando demandId não é passado', async () => {
      mockedDemands.findAll.mockResolvedValue([
        makeDemand({ id: 1, status: 'completed' }),
        makeDemand({ id: 2, status: 'completed' }),
      ] as never);
      mockedFeedback.getByDemandId.mockReturnValue([
        { feedbackType: 'like', feedbackText: null, demandId: 1 } as never,
      ]);

      const result = await registry.executeTool('get_demand_feedback', {});
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(typeof data.totalFeedbacks).toBe('number');
      expect(data).toHaveProperty('likeCount');
      expect(data).toHaveProperty('dislikeCount');
    });

    it('retorna satisfactionRate N/A quando sem feedbacks', async () => {
      mockedDemands.findAll.mockResolvedValue([] as never);
      mockedFeedback.getByDemandId.mockReturnValue([]);

      const result = await registry.executeTool('get_demand_feedback', {});
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.satisfactionRate).toBe('N/A');
    });
  });

  // -------------------------------------------------------
  // Tool: get_quality_metrics
  // -------------------------------------------------------
  describe('get_quality_metrics', () => {
    it('retorna métricas de qualidade com taxas calculadas', async () => {
      mockedDemands.findAll.mockResolvedValue([
        makeDemand({ status: 'completed', qualityGateStatus: 'passed', revisionNumber: 1 }),
        makeDemand({ status: 'completed', qualityGateStatus: 'passed', revisionNumber: 1 }),
        makeDemand({ status: 'error', qualityGateStatus: 'failed', revisionNumber: 2 }),
      ] as never);

      const result = await registry.executeTool('get_quality_metrics', {});
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data).toHaveProperty('metrics');
      expect(data).toHaveProperty('rates');
      const metrics = data.metrics as Record<string, unknown>;
      expect(metrics.total).toBe(3);
      expect(metrics.completed).toBe(2);
      expect(metrics.error).toBe(1);
    });

    it('retorna métricas zeradas para banco vazio', async () => {
      mockedDemands.findAll.mockResolvedValue([] as never);

      const result = await registry.executeTool('get_quality_metrics', {});
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      const rates = data.rates as Record<string, unknown>;
      expect(rates.success).toBe('0.0%');
    });
  });

  // -------------------------------------------------------
  // Tool: list_test_patterns
  // -------------------------------------------------------
  describe('list_test_patterns', () => {
    it('detecta frameworks via package.json e padrões nos test files', async () => {
      const packageJson = {
        dependencies: {},
        devDependencies: { vitest: '^1.0.0', '@testing-library/react': '^14.0.0' },
      };
      mockedRepo.getRepoWithFiles.mockResolvedValue(
        makeRepo([
          {
            path: 'package.json',
            filename: 'package.json',
            language: 'json',
            content: JSON.stringify(packageJson),
            size: 200,
          },
          {
            path: 'tests/foo.test.ts',
            filename: 'foo.test.ts',
            language: 'ts',
            content: 'describe("x", () => { it("y", () => {}); beforeEach(() => {}); })',
            size: 80,
          },
        ]),
      );

      const result = await registry.executeTool('list_test_patterns', {
        repoFullName: 'owner/repo',
      });
      expect(result.ok).toBe(true);
      const data = result.data as Record<string, unknown>;
      const frameworks = data.detectedFrameworks as string[];
      expect(frameworks).toContain('Vitest');
      expect(frameworks).toContain('React Testing Library');
      const patterns = data.testPatterns as string[];
      expect(patterns.some((p) => p.includes('BDD'))).toBe(true);
      expect(patterns.some((p) => p.includes('Setup'))).toBe(true);
    });

    it('retorna erro para repoFullName inválido', async () => {
      const result = await registry.executeTool('list_test_patterns', { repoFullName: 'invalid' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Formato inválido');
    });

    it('retorna erro quando repositório não encontrado', async () => {
      mockedRepo.getRepoWithFiles.mockResolvedValue(null);
      const result = await registry.executeTool('list_test_patterns', {
        repoFullName: 'owner/repo',
      });
      expect(result.ok).toBe(false);
    });
  });
});
