/**
 * Testes de integração para rotas /api/prompts sem autenticação
 *
 * Autenticação foi removida do projeto (uso local). Todos os endpoints de
 * escrita e leitura devem estar acessíveis sem login/role.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import promptVersionRoutes from '../server/routes/prompt-version-routes';

vi.mock('../server/services/prompt-version', () => ({
  promptVersionService: {
    listVersions: vi.fn().mockResolvedValue([]),
    createVersion: vi.fn().mockResolvedValue({
      id: 1,
      promptName: 'test',
      version: 'v1',
      content: 'test content',
      isActive: true,
    }),
    getVersion: vi.fn().mockResolvedValue({
      id: 1,
      promptName: 'test',
      version: 'v1',
      content: 'test content',
      isActive: true,
    }),
    activateVersion: vi.fn().mockResolvedValue(true),
    createABTest: vi.fn().mockResolvedValue({
      id: 1,
      promptName: 'test',
      versionA: 'v1',
      versionB: 'v2',
      trafficPercentB: 50,
      isActive: true,
    }),
    endABTest: vi.fn().mockResolvedValue(true),
    getActiveABTest: vi.fn().mockResolvedValue(null),
    getMetrics: vi.fn().mockResolvedValue([]),
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

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/prompts', promptVersionRoutes);
  return app;
}

describe('Prompt Routes (sem autenticação)', () => {
  it('POST /api/prompts/:name/versions acessível sem auth', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/api/prompts/test/versions')
      .send({ version: 'v1', content: 'test content' });

    expect(response.status).toBe(201);
  });

  it('POST /api/prompts/:name/activate acessível sem auth', async () => {
    const app = createApp();
    const response = await request(app).post('/api/prompts/test/activate').send({ version: 'v1' });

    expect(response.status).toBe(200);
  });

  it('POST /api/prompts/:name/ab-test acessível sem auth', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/api/prompts/test/ab-test')
      .send({ versionA: 'v1', versionB: 'v2', trafficPercentB: 50 });

    expect(response.status).toBe(201);
  });

  it('DELETE /api/prompts/:name/ab-test acessível sem auth', async () => {
    const app = createApp();
    const response = await request(app).delete('/api/prompts/test/ab-test');

    expect(response.status).toBe(200);
  });

  it('GET /api/prompts/:name acessível sem auth', async () => {
    const app = createApp();
    const response = await request(app).get('/api/prompts/test');

    expect(response.status).toBe(200);
  });

  it('GET /api/prompts/:name/ab-test acessível sem auth', async () => {
    const app = createApp();
    const response = await request(app).get('/api/prompts/test/ab-test');

    expect(response.status).toBe(200);
  });

  it('GET /api/prompts/:name/metrics acessível sem auth', async () => {
    const app = createApp();
    const response = await request(app).get('/api/prompts/test/metrics');

    expect(response.status).toBe(200);
  });
});
