import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const demandRepositoryMock = vi.hoisted(() => ({
  findByIdOrNull: vi.fn(),
  findAll: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  clearHistory: vi.fn(),
  deleteById: vi.fn(),
  markAsError: vi.fn(),
  updateStatus: vi.fn(),
}));

const aiSquadServiceMock = vi.hoisted(() => ({
  isStopRequested: vi.fn(),
  isProcessingActive: vi.fn(),
  stopProcessing: vi.fn(),
  processDemand: vi.fn(),
  processDemandRoundtable: vi.fn(),
  processDemandWithCognitiveCore: vi.fn(),
}));

const llmAuditLogServiceMock = vi.hoisted(() => ({
  getDemandUsage: vi.fn(),
}));

const agentJobsServiceMock = vi.hoisted(() => ({
  listForDemand: vi.fn(),
}));

const featureFlagsMock = vi.hoisted(() => ({
  getFlags: vi.fn(),
  setOverride: vi.fn(),
  clearOverride: vi.fn(),
  hasOverride: vi.fn(),
}));

vi.mock('../server/repositories/demand-repository', () => ({
  demandRepository: demandRepositoryMock,
}));

vi.mock('../server/services/ai-squad', () => ({
  aiSquadService: aiSquadServiceMock,
}));

vi.mock('../server/cognitive-core', () => ({
  demandClassifier: {},
  agentOrchestrator: {},
}));

vi.mock('../server/frameworks', () => ({
  frameworkManager: {},
}));

vi.mock('../server/services/llm-audit-log', () => ({
  llmAuditLogService: llmAuditLogServiceMock,
}));

vi.mock('../server/services/agent-jobs', () => ({
  agentJobsService: agentJobsServiceMock,
}));

vi.mock('../server/services/model-routing', () => ({
  modelRoutingService: { getDemandStageRuns: vi.fn() },
}));

vi.mock('../server/services/refinement-input', () => ({
  resolveRefinementInput: vi.fn(),
}));

vi.mock('../server/services/repo-service', () => ({
  repoService: {},
}));

vi.mock('../server/services/sse', () => ({
  sseManager: {
    sendProgress: vi.fn(),
    addConnection: vi.fn(() => 'connection-1'),
    sendStarted: vi.fn(),
    sendProcessing: vi.fn(),
    sendError: vi.fn(),
    removeConnection: vi.fn(),
  },
}));

vi.mock('../server/storage', () => ({
  storage: {
    createFile: vi.fn(),
    getFilesByDemandId: vi.fn(),
    getFile: vi.fn(),
    updateDemand: vi.fn(),
  },
}));

vi.mock('../server/services/feature-flags', () => ({
  featureFlags: featureFlagsMock,
}));

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import demandsRouter from '../server/routes/demands';
import { errorHandler } from '../server/middleware/error-handler';
import { insertDemandSchema } from '@shared/schema';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(demandsRouter);
  app.use(errorHandler);
  return app;
}

function baseDemand(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    title: 'Demanda X',
    description: 'Descrição',
    type: 'melhoria',
    priority: 'alta',
    status: 'processing',
    progress: 50,
    learningLog: [],
    qaEvidence: null,
    size: null,
    ...overrides,
  };
}

describe('Demanda 10089 — completion gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    featureFlagsMock.getFlags.mockReturnValue({
      enforceRepoUrlOnDemands: false,
      enforceFailureCategory: false,
      enforceLearningLogOnComplete: false,
      enforceQaChecklistOnComplete: false,
      enableDemandSizeClassification: false,
    });
  });

  describe('PATCH /api/demands/:id/status', () => {
    it('completed sem learning_log retorna 400 quando enforceLearningLogOnComplete=ON', async () => {
      featureFlagsMock.getFlags.mockReturnValue({
        enforceLearningLogOnComplete: true,
        enforceQaChecklistOnComplete: false,
        enforceFailureCategory: false,
      });
      demandRepositoryMock.findByIdOrNull.mockResolvedValueOnce(baseDemand());

      const response = await request(createApp())
        .patch('/api/demands/7/status')
        .send({ status: 'completed' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('LEARNING_LOG_REQUIRED');
    });

    it('completed sem qa_evidence retorna 400 quando enforceQaChecklistOnComplete=ON', async () => {
      featureFlagsMock.getFlags.mockReturnValue({
        enforceLearningLogOnComplete: false,
        enforceQaChecklistOnComplete: true,
        enforceFailureCategory: false,
      });
      demandRepositoryMock.findByIdOrNull.mockResolvedValueOnce(baseDemand());

      const response = await request(createApp())
        .patch('/api/demands/7/status')
        .send({ status: 'completed', learningLog: 'aprendizado' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('QA_EVIDENCE_REQUIRED');
    });

    it('completed com learning_log e qa_evidence persiste e retorna 200', async () => {
      featureFlagsMock.getFlags.mockReturnValue({
        enforceLearningLogOnComplete: true,
        enforceQaChecklistOnComplete: true,
        enforceFailureCategory: false,
      });
      demandRepositoryMock.findByIdOrNull.mockResolvedValueOnce(baseDemand());
      demandRepositoryMock.update.mockResolvedValueOnce(
        baseDemand({
          status: 'completed',
          progress: 100,
          learningLog: ['aprendizado'],
          qaEvidence: 'cenário negativo documentado',
        }),
      );

      const response = await request(createApp()).patch('/api/demands/7/status').send({
        status: 'completed',
        learningLog: 'aprendizado',
        qaEvidence: 'cenário negativo documentado',
      });

      expect(response.status).toBe(200);
      expect(demandRepositoryMock.update).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
          status: 'completed',
          learningLog: ['aprendizado'],
          qaEvidence: 'cenário negativo documentado',
        }),
      );
    });

    it('completed aceita demanda com learning_log pré-preenchido via endpoint dedicado', async () => {
      featureFlagsMock.getFlags.mockReturnValue({
        enforceLearningLogOnComplete: true,
        enforceQaChecklistOnComplete: false,
        enforceFailureCategory: false,
      });
      demandRepositoryMock.findByIdOrNull.mockResolvedValueOnce(
        baseDemand({ learningLog: ['aprendizado existente'] }),
      );
      demandRepositoryMock.update.mockResolvedValueOnce(
        baseDemand({ status: 'completed', progress: 100, learningLog: ['aprendizado existente'] }),
      );

      const response = await request(createApp())
        .patch('/api/demands/7/status')
        .send({ status: 'completed' });

      expect(response.status).toBe(200);
    });

    it('stopped sem failure_category retorna 400 quando enforceFailureCategory=ON', async () => {
      featureFlagsMock.getFlags.mockReturnValue({
        enforceFailureCategory: true,
        enforceLearningLogOnComplete: false,
        enforceQaChecklistOnComplete: false,
      });
      demandRepositoryMock.findByIdOrNull.mockResolvedValueOnce(baseDemand());

      const response = await request(createApp())
        .patch('/api/demands/7/status')
        .send({ status: 'stopped' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('FAILURE_CATEGORY_REQUIRED');
    });

    it('stopped com OUTRO sem other_detail retorna 400', async () => {
      featureFlagsMock.getFlags.mockReturnValue({
        enforceFailureCategory: true,
        enforceLearningLogOnComplete: false,
        enforceQaChecklistOnComplete: false,
      });
      demandRepositoryMock.findByIdOrNull.mockResolvedValueOnce(baseDemand());

      const response = await request(createApp()).patch('/api/demands/7/status').send({
        status: 'stopped',
        failureCategory: 'OUTRO',
      });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('FAILURE_CATEGORY_REQUIRED');
    });

    it('stopped com failure_category válida retorna 200', async () => {
      featureFlagsMock.getFlags.mockReturnValue({
        enforceFailureCategory: true,
        enforceLearningLogOnComplete: false,
        enforceQaChecklistOnComplete: false,
      });
      demandRepositoryMock.findByIdOrNull.mockResolvedValueOnce(baseDemand());
      demandRepositoryMock.update.mockResolvedValueOnce(baseDemand({ status: 'stopped' }));

      const response = await request(createApp()).patch('/api/demands/7/status').send({
        status: 'stopped',
        failureCategory: 'FALHA_VALIDACAO',
      });

      expect(response.status).toBe(200);
    });
  });

  describe('POST /api/demands/:id/learning-log', () => {
    it('anexa entrada ao learning_log existente', async () => {
      demandRepositoryMock.findByIdOrNull
        .mockResolvedValueOnce(baseDemand({ learningLog: ['anterior'] }))
        .mockResolvedValueOnce(baseDemand({ learningLog: ['anterior'] }));
      demandRepositoryMock.update.mockResolvedValueOnce(
        baseDemand({ learningLog: ['anterior', 'novo'] }),
      );

      const response = await request(createApp())
        .post('/api/demands/7/learning-log')
        .send({ entry: 'novo' });

      expect(response.status).toBe(200);
      expect(demandRepositoryMock.update).toHaveBeenCalledWith(7, {
        learningLog: ['anterior', 'novo'],
      });
    });

    it('rejeita entrada vazia', async () => {
      demandRepositoryMock.findByIdOrNull.mockResolvedValueOnce(baseDemand());

      const response = await request(createApp())
        .post('/api/demands/7/learning-log')
        .send({ entry: '   ' });

      expect(response.status).toBe(400);
    });
  });

  describe('insertDemandSchema — classificação P/M/G', () => {
    it('aceita size P, M ou G', () => {
      for (const size of ['P', 'M', 'G']) {
        const result = insertDemandSchema.safeParse({
          title: 'Título',
          description: 'Descrição',
          type: 'melhoria',
          priority: 'media',
          size,
        });
        expect(result.success).toBe(true);
      }
    });

    it('rejeita size fora de P/M/G', () => {
      const result = insertDemandSchema.safeParse({
        title: 'Título',
        description: 'Descrição',
        type: 'melhoria',
        priority: 'media',
        size: 'XG',
      });
      expect(result.success).toBe(false);
    });

    it('size é opcional', () => {
      const result = insertDemandSchema.safeParse({
        title: 'Título',
        description: 'Descrição',
        type: 'melhoria',
        priority: 'media',
      });
      expect(result.success).toBe(true);
    });
  });
});
