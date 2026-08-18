/**
 * Spec 10006 — GET /api/demands/:id/export/bundle/manifest
 * Devolve o manifest simplificado (sem hashes/URLs) para a tela.
 */
import express from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const demands = vi.hoisted(
  () =>
    ({
      1: {
        id: 1,
        title: 'com prd',
        type: 'feature',
        priority: 'alta',
        prdUrl: null,
        tasksUrl: null,
        tddUrl: null,
      },
      2: {
        id: 2,
        title: 'sem prd',
        type: 'feature',
        priority: 'media',
        prdUrl: null,
        tasksUrl: null,
        tddUrl: null,
      },
    }) as Record<number, Record<string, unknown>>,
);

const repoMock = vi.hoisted(() => ({
  findByIdOrNull: vi.fn(async (id: number) => demands[id] ?? null),
}));

const versioningMock = vi.hoisted(() => ({
  load: vi.fn(async (id: number, type: 'prd' | 'tasks') => {
    const prd: Record<number, string> = { 1: '# PRD demanda 1', 2: '' };
    const content = type === 'prd' ? (prd[id] ?? '') : id === 1 ? '# Tasks' : '';
    return {
      demandId: id,
      type,
      content,
      version: content ? 3 : 0,
      hash: '',
      updatedAt: new Date(0).toISOString(),
      hasPreviousVersion: false,
    };
  }),
}));

vi.mock('../server/repositories/demand-repository', () => ({ demandRepository: repoMock }));
vi.mock('../server/services/document-versioning', () => ({
  documentVersioningService: versioningMock,
}));

import { errorHandler } from '../server/middleware/error-handler';

describe('GET /api/demands/:id/export/bundle/manifest (spec 10006)', () => {
  let app: express.Express;
  beforeAll(async () => {
    const { default: demandsRouter } = await import('../server/routes/demands');
    app = express();
    app.use(express.json());
    app.use(demandsRouter);
    app.use(errorHandler);
  });

  it('200: manifest simplificado sem hashes nem sha256', async () => {
    const res = await request(app).get('/api/demands/1/export/bundle/manifest');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      format: 'aichatflow-handoff/v1',
      demandId: 1,
      demandTitle: 'com prd',
      documentCount: 3,
      hasSpec: true,
      hasTasks: true,
      hasConstitution: true,
    });
    // Nenhum hash exposto para a UI (edge case da spec).
    expect(JSON.stringify(res.body)).not.toContain('sha256');
    expect(res.body.documents).toBeUndefined();
  });

  it('422: demanda sem PRD (o frontend trata como "sem handoff")', async () => {
    const res = await request(app).get('/api/demands/2/export/bundle/manifest');
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('HANDOFF_PRD_MISSING');
  });

  it('404: demanda inexistente', async () => {
    const res = await request(app).get('/api/demands/999999/export/bundle/manifest');
    expect(res.status).toBe(404);
  });
});
