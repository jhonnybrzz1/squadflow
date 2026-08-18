import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const demandRepositoryMock = vi.hoisted(() => ({
  findByIdOrNull: vi.fn(),
  findAll: vi.fn(),
  clearHistory: vi.fn(),
  deleteById: vi.fn(),
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

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(demandsRouter);
  app.use(errorHandler);
  return app;
}

describe('Demand control routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    llmAuditLogServiceMock.getDemandUsage.mockResolvedValue({
      records: [],
      totalCost: 0,
      tokensIn: 0,
      tokensOut: 0,
      unpricedCount: 0,
      unpricedTokens: 0,
    });
  });

  it('retorna custos HTTP agrupados por agente, ferramenta e não atribuído', async () => {
    demandRepositoryMock.findByIdOrNull.mockResolvedValueOnce({ id: 7, status: 'completed' });
    llmAuditLogServiceMock.getDemandUsage.mockResolvedValue({
      totalCost: 0.006,
      tokensIn: 400,
      tokensOut: 200,
      unpricedCount: 0,
      unpricedTokens: 0,
      records: [
        {
          operation: 'agent:qa:reflection',
          model: 'provider:model-a',
          estimatedCostUsd: 0.003,
          totalTokens: 300,
        },
        {
          operation: 'tool:web_search',
          model: 'provider:model-a',
          estimatedCostUsd: 0.001,
          totalTokens: 100,
        },
        {
          operation: 'document:prd',
          model: 'provider:model-b',
          estimatedCostUsd: 0.002,
          totalTokens: 200,
        },
      ],
    });

    const response = await request(createApp()).get('/api/demands/7/costs');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      demandId: 7,
      totalCost: 0.006,
      totalRecords: 3,
      byAgent: { qa: { cost: 0.003, tokens: 300, count: 1 } },
      byTool: { web_search: { cost: 0.001, tokens: 100, count: 1 } },
      unattributed: { cost: 0.002, tokens: 200, count: 1 },
    });
  });

  it('expõe unpriced (chamadas sem preço) da fonte durável — spec 10056', async () => {
    demandRepositoryMock.findByIdOrNull.mockResolvedValueOnce({ id: 7, status: 'completed' });
    llmAuditLogServiceMock.getDemandUsage.mockResolvedValue({
      totalCost: 0.005,
      tokensIn: 100,
      tokensOut: 50,
      unpricedCount: 2,
      unpricedTokens: 900,
      records: [
        {
          operation: 'roundtable:qa:turn1',
          model: 'openrouter:deepseek-v4-flash',
          estimatedCostUsd: 0.005,
          totalTokens: 150,
        },
      ],
    });

    const response = await request(createApp()).get('/api/demands/7/costs');

    expect(response.status).toBe(200);
    expect(response.body.unpriced).toEqual({ count: 2, tokens: 900 });
  });

  it('GET /api/demands/:id/metadata retorna a projeção curada — spec 10064', async () => {
    demandRepositoryMock.findByIdOrNull.mockResolvedValueOnce({
      id: 7,
      title: 'Demanda X',
      description: 'sensível — não deve vazar',
      type: 'melhoria',
      priority: 'alta',
      refinementType: 'technical',
      status: 'completed',
      domain: 'padrao',
      qualityGateStatus: 'passed',
      promptTokens: 100,
      completionTokens: 50,
      custoEstimado: 0.01,
      repoFullName: 'example-org/AiChatFlow1',
      chatMessages: [
        { id: '1', agent: 'product_owner', message: 'a', timestamp: '', type: 'completed' },
        { id: '2', agent: 'tech_lead', message: 'b', timestamp: '', type: 'completed' },
      ],
    });

    const response = await request(createApp()).get('/api/demands/7/metadata');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: 7,
      type: 'melhoria',
      agentCount: 2,
      custoEstimado: 0.01,
    });
    // Não vaza campos pesados/sensíveis.
    expect(response.body.chatMessages).toBeUndefined();
    expect(response.body.description).toBeUndefined();
  });

  it('GET /api/demands/:id/metadata retorna 404 quando não existe', async () => {
    demandRepositoryMock.findByIdOrNull.mockResolvedValueOnce(null);
    const response = await request(createApp()).get('/api/demands/999/metadata');
    expect(response.status).toBe(404);
  });

  it('GET /api/demands/:id/agent-jobs devolve jobs com steps sem vazar hash — spec 10064 B2', async () => {
    agentJobsServiceMock.listForDemand.mockResolvedValueOnce([
      {
        id: 'job-1',
        demandId: 7,
        speckitPath: 'specs/7/spec.md',
        status: 'succeeded',
        promptSentHash: 'segredo-hash',
        filesModified: ['server/a.ts'],
        typecheckPassed: true,
        apiCostUsd: 0.08,
        humanEditsCount: 0,
        cancelledAt: null,
        errorMessage: null,
        steps: [{ kind: 'tool', label: 'Edit server/a.ts' }],
        createdAt: '2026-07-22T00:00:00.000Z',
      },
    ]);

    const response = await request(createApp()).get('/api/demands/7/agent-jobs');

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({
      id: 'job-1',
      status: 'succeeded',
      steps: [{ kind: 'tool', label: 'Edit server/a.ts' }],
    });
    // Não vaza o hash interno.
    expect(response.body[0].promptSentHash).toBeUndefined();
  });

  it('GET /api/demands/:id/agent-jobs devolve [] quando não há jobs', async () => {
    agentJobsServiceMock.listForDemand.mockResolvedValueOnce([]);
    const response = await request(createApp()).get('/api/demands/7/agent-jobs');
    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it('marca parada imediatamente via POST /api/demands/:id/stop', async () => {
    demandRepositoryMock.findByIdOrNull
      .mockResolvedValueOnce({ id: 7, status: 'processing' })
      .mockResolvedValueOnce({ id: 7, status: 'stopped' });
    aiSquadServiceMock.stopProcessing.mockResolvedValueOnce(undefined);

    const response = await request(createApp()).post('/api/demands/7/stop');

    expect(response.status).toBe(200);
    expect(aiSquadServiceMock.stopProcessing).toHaveBeenCalledWith(7);
    expect(response.body).toMatchObject({
      message: 'Stop request sent',
      demand: { id: 7, status: 'stopped' },
    });
  });

  it('limpa historico quando nao ha demanda ativa', async () => {
    demandRepositoryMock.findAll.mockResolvedValueOnce([
      { id: 1, status: 'completed' },
      { id: 2, status: 'processing' },
    ]);
    aiSquadServiceMock.isProcessingActive.mockReturnValue(false);
    demandRepositoryMock.clearHistory.mockResolvedValueOnce({ deleted: 2 });

    const response = await request(createApp()).delete('/api/demands/history');

    expect(response.status).toBe(200);
    expect(demandRepositoryMock.clearHistory).toHaveBeenCalled();
    expect(response.body).toEqual({ success: true, deleted: 2 });
  });

  it('bloqueia limpeza de historico enquanto ha demanda ativa', async () => {
    demandRepositoryMock.findAll.mockResolvedValueOnce([{ id: 3, status: 'processing' }]);
    aiSquadServiceMock.isProcessingActive.mockReturnValue(true);

    const response = await request(createApp()).delete('/api/demands/history');

    expect(response.status).toBe(409);
    expect(demandRepositoryMock.clearHistory).not.toHaveBeenCalled();
    expect(response.body.errorCode).toBe('CONFLICT');
    expect(response.body.context.activeDemandIds).toEqual([3]);
  });

  // Spec 10013 (FR-004): exclusão individual
  it('exclui uma demanda individual (200) e chama deleteById', async () => {
    aiSquadServiceMock.isProcessingActive.mockReturnValue(false);
    demandRepositoryMock.deleteById.mockResolvedValueOnce(true);

    const response = await request(createApp()).delete('/api/demands/42');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, demandId: 42 });
    expect(demandRepositoryMock.deleteById).toHaveBeenCalledWith(42);
  });

  it('retorna 404 quando a demanda não existe', async () => {
    aiSquadServiceMock.isProcessingActive.mockReturnValue(false);
    demandRepositoryMock.deleteById.mockResolvedValueOnce(false);

    const response = await request(createApp()).delete('/api/demands/999');

    expect(response.status).toBe(404);
  });

  it('bloqueia exclusão (409) enquanto a demanda está processando', async () => {
    aiSquadServiceMock.isProcessingActive.mockReturnValue(true);

    const response = await request(createApp()).delete('/api/demands/7');

    expect(response.status).toBe(409);
    expect(response.body.errorCode).toBe('CONFLICT');
    expect(demandRepositoryMock.deleteById).not.toHaveBeenCalled();
  });
});
