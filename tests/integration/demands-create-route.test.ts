import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { registerRoutes } from '../../server/routes';

let nextDemandId = 9900;

vi.mock('../../server/services/demand-generation-jobs', () => ({
  demandGenerationJobsService: {
    enqueue: vi.fn().mockResolvedValue('job-id'),
  },
}));

vi.mock('../../server/workers/demand-generation-worker', () => ({
  enqueueDemandGenerationJob: vi.fn(),
}));

vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: {
    create: vi.fn().mockImplementation(async (data) => {
      nextDemandId += 1;
      return {
        id: nextDemandId,
        status: 'pending',
        title: data.title,
        description: data.description,
        originalDescription: data.originalDescription,
        type: data.type,
        priority: data.priority,
        domain: data.domain ?? 'padrao',
        refinementType: data.refinementType ?? null,
        repoFullName: data.repoFullName ?? null,
        skillRawUrl: data.skillRawUrl ?? null,
        progress: 0,
        currentAgent: null,
        errorMessage: null,
        chatMessages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }),
    findByIdOrNull: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(true),
    findAll: vi.fn().mockResolvedValue([]),
    clearHistory: vi.fn().mockResolvedValue({ deleted: 0 }),
    deleteById: vi.fn().mockResolvedValue(true),
    markAsError: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('../../server/services/repo-service', () => ({
  repoService: {
    getOrCreateRepo: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../server/storage', () => ({
  storage: {
    createFile: vi.fn().mockResolvedValue({ id: 1 }),
  },
}));

vi.mock('../../server/services/dynamic-agent-triage', () => ({
  selectAgentsForDemand: vi.fn().mockResolvedValue({ selectedAgents: [], fallback: true }),
}));

vi.mock('../../server/services/ai-squad', () => ({
  aiSquadService: {
    isProcessingActive: vi.fn().mockReturnValue(false),
    isStopRequested: vi.fn().mockReturnValue(false),
  },
}));

describe('POST /api/demands integration', () => {
  let app: express.Express;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    await registerRoutes(app);
    const { errorHandler } = await import('../../server/middleware/error-handler');
    app.use(errorHandler);
  });

  afterAll(() => {
    vi.clearAllMocks();
  });

  it('returns 201 and the created demand with generationJobId', async () => {
    const payload = {
      title: 'Teste de criação de demanda',
      description: 'Descrição de teste',
      type: 'analise_exploratoria',
      priority: 'media',
      refinementType: 'business',
    };

    const response = await request(app).post('/api/demands').send(payload);

    if (response.status !== 201) {
      console.log('POST /api/demands error:', response.body);
    }

    expect(response.status).toBe(201);
    expect(response.body).toHaveProperty('id');
    expect(response.body.title).toBe(payload.title);
    expect(response.body.status).toBe('pending');
    expect(response.body.generationJobId).toBe('job-id');
  });
});
