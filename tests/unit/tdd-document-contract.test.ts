import express from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const repoMock = vi.hoisted(() => ({
  findByIdOrNull: vi.fn(async (id: number) =>
    id === 1
      ? {
          id: 1,
          title: 'demanda técnica',
          type: 'produto',
          priority: 'alta',
          status: 'completed',
          prdUrl: null,
          tasksUrl: null,
          tddUrl: '/documents/tdd_demanda_1.pdf',
          chatMessages: [],
        }
      : null,
  ),
  update: vi.fn(async () => undefined),
  findAll: vi.fn(async () => []),
}));

const versioningMock = vi.hoisted(() => ({
  load: vi.fn(async () => ({
    content: '# TDD conteudo',
    version: 2,
    hash: 'abc',
    updatedAt: new Date().toISOString(),
    hasPreviousVersion: true,
  })),
  save: vi.fn(async () => ({ version: 3, hash: 'def' })),
  revert: vi.fn(async () => ({ version: 2, hash: 'abc' })),
}));

vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: repoMock,
}));

vi.mock('../../server/services/document-versioning', () => ({
  documentVersioningService: versioningMock,
}));

vi.mock('../../server/services/document-jobs', () => ({
  documentJobsService: {
    enqueue: vi.fn(async () => 'job-test'),
    latestFor: vi.fn(async () => null),
    markRunning: vi.fn(),
    markSucceeded: vi.fn(),
    markFailed: vi.fn(),
    recoverOnStartup: vi.fn(async () => []),
  },
}));

import { errorHandler } from '../../server/middleware/error-handler';

describe('Documento técnico tdd nas rotas de documentos (spec 014 S1 / H-08)', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: demandsRouter } = await import('../../server/routes/demands');
    app = express();
    app.use(express.json());
    app.use(demandsRouter);
    app.use(errorHandler);
  });

  it('GET /api/demands/:id/documents/tdd retorna o documento técnico', async () => {
    const res = await request(app).get('/api/demands/1/documents/tdd');
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('tdd');
    expect(res.body.content).toContain('TDD conteudo');
    expect(versioningMock.load).toHaveBeenCalledWith(1, 'tdd');
  });

  it('POST /api/demands/:id/documents/tdd salva e dispara regeneração via tddUrl', async () => {
    const res = await request(app)
      .post('/api/demands/1/documents/tdd')
      .send({ content: '# TDD novo', ifMatchVersion: 2 });
    expect(res.status).toBe(200);
    expect(versioningMock.save).toHaveBeenCalledWith(1, 'tdd', '# TDD novo', 2, undefined);
  });

  it('POST /api/demands/:id/documents/tdd/revert funciona', async () => {
    const res = await request(app).post('/api/demands/1/documents/tdd/revert');
    expect(res.status).toBe(200);
    expect(versioningMock.revert).toHaveBeenCalledWith(1, 'tdd');
  });

  it('tipo desconhecido continua rejeitado (contrato fechado)', async () => {
    const res = await request(app).get('/api/demands/1/documents/design');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
