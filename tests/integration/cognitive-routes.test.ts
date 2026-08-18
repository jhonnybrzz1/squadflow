import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { registerRoutes } from '../../server/routes';
import { deepCompareIgnoreVolatile } from '../utils/deep-compare';

// Mock repositories and services
vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: {
    create: vi
      .fn()
      .mockImplementation(async (data) => ({ id: 999, status: 'pending', title: data.title })),
    findByIdOrNull: vi.fn().mockResolvedValue({ id: 999, status: 'pending', title: 'Mock' }),
    update: vi.fn().mockResolvedValue(true),
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

vi.mock('../../server/cognitive-core/demand-classifier', () => ({
  demandClassifier: {
    classifyDemand: vi.fn().mockResolvedValue({ score: 100, label: 'high' }),
  },
}));

describe('Cognitive Routes Integration Tests', () => {
  let app: express.Express;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    await registerRoutes(app);
    // Mount the error handler so ZodErrors return 400 properly
    const { errorHandler } = await import('../../server/middleware/error-handler');
    app.use(errorHandler);
  });

  afterAll(() => {
    // Teardown
  });

  it('GET /api/demands/:id/classification - Should return cognitive classification', async () => {
    // demandRepository.findByIdOrNull is mocked to return { id: 999, ... }
    const demandId = 999;

    const response = await request(app).get(`/api/demands/${demandId}/classification`).expect(200);

    expect(response.body).toHaveProperty('classification');
    expect(response.body.demandId).toBe(demandId);
  });

  it('mounts LLM audit routes only under /debug', async () => {
    const debugResponse = await request(app).get('/debug/logs');
    expect(debugResponse.status).not.toBe(404);
    await request(app).get('/metrics/logs').expect(404);
  });

  it('Should validate semantic regression using deep compare (Baseline vs Refactored)', async () => {
    const baselineResponse = {
      title: 'Dúvida NCM',
      status: 'pending',
      timestamp: '2025-05-30T10:00:00.000Z',
      id: 999,
    };

    const newResponse = {
      title: 'Dúvida NCM',
      status: 'pending',
      timestamp: '2025-06-01T10:00:00.000Z', // Different timestamp
      id: 1000, // Different ID
    };

    const isSemanticallyEqual = deepCompareIgnoreVolatile(baselineResponse, newResponse);
    expect(isSemanticallyEqual).toBe(true);
  });
});
