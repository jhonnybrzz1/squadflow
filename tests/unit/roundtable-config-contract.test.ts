import express from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SSE_ROUNDTABLE_EVENTS } from '../../client/src/lib/api';

const repoMock = vi.hoisted(() => ({
  create: vi.fn(async (data: Record<string, unknown>, options?: Record<string, unknown>) => ({
    id: 42,
    ...data,
    ...(options?.roundtableConfig ? { roundtableConfig: options.roundtableConfig } : {}),
  })),
  update: vi.fn(async () => undefined),
  findByIdOrNull: vi.fn(async () => null),
  findAll: vi.fn(async () => []),
  markAsError: vi.fn(async () => undefined),
}));

const squadMock = vi.hoisted(() => ({
  processDemandRoundtable: vi.fn(async () => undefined),
  processDemand: vi.fn(async () => undefined),
  isStopRequested: vi.fn(() => false),
  isProcessingActive: vi.fn(() => false),
}));

const demandGenerationJobsMock = vi.hoisted(() => ({
  enqueue: vi.fn(async () => 'generation-job-1'),
}));

const demandGenerationWorkerMock = vi.hoisted(() => ({
  enqueueDemandGenerationJob: vi.fn(),
}));

vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: repoMock,
}));

vi.mock('../../server/services/ai-squad', () => ({
  aiSquadService: squadMock,
}));

vi.mock('../../server/services/demand-generation-jobs', () => ({
  demandGenerationJobsService: demandGenerationJobsMock,
}));

vi.mock('../../server/workers/demand-generation-worker', () => demandGenerationWorkerMock);

vi.mock('../../server/services/classifier-observability', () => ({
  recordClassifierSubmission: vi.fn(),
}));

const flagsState = vi.hoisted(() => ({ enableDynamicAgentTriage: false }));
vi.mock('../../server/services/feature-flags', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../server/services/feature-flags')>();
  return {
    ...original,
    featureFlags: {
      ...original.featureFlags,
      getFlags: () => ({ ...original.featureFlags.getFlags(), ...flagsState }),
    },
  };
});

const triageMock = vi.hoisted(() => ({ selectAgentsForDemand: vi.fn() }));
vi.mock('../../server/services/dynamic-agent-triage', () => triageMock);

import { errorHandler } from '../../server/middleware/error-handler';
import { DEFAULT_ROUNDTABLE_AGENTS } from '../../server/cognitive-core/roundtable-agents';

describe('Mesa redonda reproduzível (spec 014 S3)', () => {
  let app: express.Express;

  beforeEach(() => {
    flagsState.enableDynamicAgentTriage = false;
    triageMock.selectAgentsForDemand.mockReset();
  });

  beforeAll(async () => {
    const { default: demandsRouter } = await import('../../server/routes/demands');
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(demandsRouter);
    app.use(errorHandler);
  });

  it('SC-004: todos os eventos ativos do protocolo têm consumidor registrado, incluindo o token', () => {
    expect(SSE_ROUNDTABLE_EVENTS).toContain('roundtable_agent_token');
    expect(SSE_ROUNDTABLE_EVENTS).toContain('roundtable_agent_message');
    expect(SSE_ROUNDTABLE_EVENTS).toContain('roundtable_complete');
  });

  it('SC-003 (M-02): roundtableConfig é persistido ANTES da execução e igual ao executado', async () => {
    const res = await request(app).post('/api/demands').send({
      title: 'Demanda mesa redonda',
      description: 'Descrição suficientemente longa para o teste de configuração.',
      type: 'melhoria',
      priority: 'alta',
      roundtableAgentIds: 'pm,qa,tech_lead',
      maxRounds: '2',
    });

    expect(res.status).toBeLessThan(400);

    // Persistência ocorreu com a config real dentro de DemandService.create...
    const persistCall = repoMock.create.mock.calls.find(
      (call) => (call[1] as Record<string, unknown>)?.roundtableConfig,
    );
    expect(persistCall).toBeDefined();
    const persisted = (persistCall![1] as { roundtableConfig: unknown }).roundtableConfig;
    expect(persisted).toEqual({
      agentIds: ['pm', 'qa', 'tech_lead'],
      maxRounds: 2,
    });

    // ...e é idêntica à configuração enfileirada para execução durável.
    expect(demandGenerationJobsMock.enqueue).toHaveBeenCalledWith(42, {
      agentIds: ['pm', 'qa', 'tech_lead'],
      maxRounds: 2,
      refinementLevel: 3,
    });
    expect(demandGenerationWorkerMock.enqueueDemandGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'generation-job-1',
        demandId: 42,
        config: {
          agentIds: ['pm', 'qa', 'tech_lead'],
          maxRounds: 2,
          refinementLevel: 3,
        },
      }),
    );
    expect(squadMock.processDemandRoundtable).not.toHaveBeenCalled();

    // Ordem: persistir (create) antes de aceitar/enfileirar a execução.
    const createOrder = repoMock.create.mock.invocationCallOrder[0];
    const enqueueOrder = demandGenerationJobsMock.enqueue.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(enqueueOrder);
  });

  it('spec 10058: sem roundtableAgentIds, usa a squad canônica de 7 (não o trio hardcoded)', async () => {
    repoMock.create.mockClear();
    demandGenerationJobsMock.enqueue.mockClear();
    demandGenerationWorkerMock.enqueueDemandGenerationJob.mockClear();
    squadMock.processDemandRoundtable.mockClear();

    const res = await request(app).post('/api/demands').send({
      title: 'Demanda sem lista de agentes',
      description: 'Descrição suficientemente longa para o teste de default de agentes.',
      type: 'melhoria',
      priority: 'alta',
      // roundtableAgentIds AUSENTE de propósito
    });

    expect(res.status).toBeLessThan(400);

    // A config persistida traz os 7 canônicos, não [] nem o trio PO/TL/QA.
    const persistCall = repoMock.create.mock.calls.find(
      (call) => (call[1] as Record<string, unknown>)?.roundtableConfig,
    );
    expect(persistCall).toBeDefined();
    const persisted = (persistCall![1] as { roundtableConfig: { agentIds: string[] } })
      .roundtableConfig;
    expect(persisted.agentIds).toEqual(DEFAULT_ROUNDTABLE_AGENTS);
    expect(persisted.agentIds).toContain('anti_overengineering');
    expect(persisted.agentIds).toHaveLength(7);

    // E o job durável recebe a mesma squad.
    const queued = demandGenerationJobsMock.enqueue.mock.calls[0][1] as { agentIds: string[] };
    expect(queued.agentIds).toEqual(DEFAULT_ROUNDTABLE_AGENTS);
  });

  it('spec 10067: usa constraints do tipo quando refinementLevel não vem no request', async () => {
    repoMock.update.mockClear();
    demandGenerationJobsMock.enqueue.mockClear();
    demandGenerationWorkerMock.enqueueDemandGenerationJob.mockClear();

    const res = await request(app).post('/api/demands').send({
      title: 'Bug sem refinementLevel explícito',
      description: 'Endpoint retorna erro 500 ao salvar.',
      type: 'bug',
      priority: 'alta',
    });

    expect(res.status).toBeLessThan(400);
    expect(demandGenerationJobsMock.enqueue).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ refinementLevel: 2 }),
    );
  });

  describe('demanda 10081 parte A: triagem dinâmica de agentes', () => {
    it('flag OFF (default): não chama a triagem, usa a squad canônica de 7', async () => {
      repoMock.create.mockClear();

      const res = await request(app).post('/api/demands').send({
        title: 'Demanda sem lista, flag off',
        description: 'Descrição suficientemente longa para o teste de flag off.',
        type: 'melhoria',
        priority: 'alta',
      });

      expect(res.status).toBeLessThan(400);
      expect(triageMock.selectAgentsForDemand).not.toHaveBeenCalled();
      const persistCall = repoMock.create.mock.calls.find(
        (call) => (call[1] as Record<string, unknown>)?.roundtableConfig,
      );
      const persisted = (persistCall![1] as { roundtableConfig: { agentIds: string[] } })
        .roundtableConfig;
      expect(persisted.agentIds).toEqual(DEFAULT_ROUNDTABLE_AGENTS);
    });

    it('flag ON + sem lista do cliente: usa a seleção da triagem e persiste triageReasoning', async () => {
      flagsState.enableDynamicAgentTriage = true;
      triageMock.selectAgentsForDemand.mockResolvedValue({
        selectedAgents: ['product_owner', 'financial_analyst', 'tech_lead'],
        reasoning: 'Demanda de precificação, precisa de análise financeira',
        confidence: 0.9,
        fallback: false,
      });
      repoMock.create.mockClear();

      const res = await request(app).post('/api/demands').send({
        title: 'Ajustar preço do plano',
        description: 'Descrição suficientemente longa para o teste de triagem ligada.',
        type: 'melhoria',
        priority: 'alta',
      });

      expect(res.status).toBeLessThan(400);
      expect(triageMock.selectAgentsForDemand).toHaveBeenCalledTimes(1);
      const persistCall = repoMock.create.mock.calls.find(
        (call) => (call[1] as Record<string, unknown>)?.roundtableConfig,
      );
      const persisted = (
        persistCall![1] as {
          roundtableConfig: { agentIds: string[]; triageReasoning?: string };
        }
      ).roundtableConfig;
      expect(persisted.agentIds).toEqual(['product_owner', 'financial_analyst', 'tech_lead']);
      expect(persisted.triageReasoning).toBe(
        'Demanda de precificação, precisa de análise financeira',
      );
    });

    it('flag ON + triagem cai em fallback: mantém a squad canônica de 7', async () => {
      flagsState.enableDynamicAgentTriage = true;
      triageMock.selectAgentsForDemand.mockResolvedValue({
        selectedAgents: [],
        reasoning: '',
        confidence: 0,
        fallback: true,
      });
      repoMock.create.mockClear();

      const res = await request(app).post('/api/demands').send({
        title: 'Demanda qualquer',
        description: 'Descrição suficientemente longa para o teste de fallback.',
        type: 'melhoria',
        priority: 'alta',
      });

      expect(res.status).toBeLessThan(400);
      const persistCall = repoMock.create.mock.calls.find(
        (call) => (call[1] as Record<string, unknown>)?.roundtableConfig,
      );
      const persisted = (persistCall![1] as { roundtableConfig: { agentIds: string[] } })
        .roundtableConfig;
      expect(persisted.agentIds).toEqual(DEFAULT_ROUNDTABLE_AGENTS);
    });

    it('flag ON + cliente manda lista explícita: cliente sempre vence, triagem nem é chamada', async () => {
      flagsState.enableDynamicAgentTriage = true;
      repoMock.create.mockClear();

      const res = await request(app).post('/api/demands').send({
        title: 'Demanda com lista explícita',
        description: 'Descrição suficientemente longa para o teste de override do cliente.',
        type: 'melhoria',
        priority: 'alta',
        roundtableAgentIds: 'product_owner,qa,tech_lead',
      });

      expect(res.status).toBeLessThan(400);
      expect(triageMock.selectAgentsForDemand).not.toHaveBeenCalled();
      const persistCall = repoMock.create.mock.calls.find(
        (call) => (call[1] as Record<string, unknown>)?.roundtableConfig,
      );
      const persisted = (persistCall![1] as { roundtableConfig: { agentIds: string[] } })
        .roundtableConfig;
      expect(persisted.agentIds).toEqual(['product_owner', 'qa', 'tech_lead']);
    });
  });
});
