import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { registerRoutes } from '../../server/routes';

vi.mock('../../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('PATCH /api/retrospective/:retroId/actions/:actionId', () => {
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

  it('returns 404 when the retrospective does not exist', async () => {
    const response = await request(app)
      .patch('/api/retrospective/retro-123/actions/action-456')
      .send({ metricAfter: 800 });

    expect(response.status).toBe(404);
  });

  it('creates and updates an action end-to-end returning diffPercent and successMet', async () => {
    // 1. generate a retrospective snapshot
    const generateResponse = await request(app)
      .post('/api/retrospective/generate')
      .send({ periodStart: '2026-07-01', periodEnd: '2026-07-31' });

    expect(generateResponse.status).toBe(201);
    const retroId = generateResponse.body.id as string;

    // 2. create an action
    const createResponse = await request(app)
      .post(`/api/retrospective/${retroId}/actions`)
      .send({ description: 'reduzir tokens', metricKey: 'tokens' });

    expect(createResponse.status).toBe(201);
    const actionId = createResponse.body.id as string;
    expect(createResponse.body.metricBefore).toBe(0); // snapshot has 0 tokens for empty period
    expect(createResponse.body.retroId).toBe(retroId);

    // 3. update metricAfter
    const patchResponse = await request(app)
      .patch(`/api/retrospective/${retroId}/actions/${actionId}`)
      .send({ metricAfter: 0 });

    expect(patchResponse.status).toBe(200);
    expect(patchResponse.body.metricAfter).toBe(0);
    // baseline 0 means diffPercent stays null (protected division)
    expect(patchResponse.body.diffPercent).toBeNull();
    expect(patchResponse.body.successMet).toBeNull();
  });

  it('rejects non-finite metricAfter with 400', async () => {
    const generateResponse = await request(app)
      .post('/api/retrospective/generate')
      .send({ periodStart: '2026-07-01', periodEnd: '2026-07-31' });

    const retroId = generateResponse.body.id as string;

    const createResponse = await request(app)
      .post(`/api/retrospective/${retroId}/actions`)
      .send({ description: 'reduzir custo', metricKey: 'cost' });

    const actionId = createResponse.body.id as string;

    const patchResponse = await request(app)
      .patch(`/api/retrospective/${retroId}/actions/${actionId}`)
      .send({ metricAfter: Infinity });

    expect(patchResponse.status).toBe(400);
  });
});
