/**
 * Spec 10044 — integração da rota POST /api/demands/:id/send-to-claude
 * (disparo MANUAL do agente de código). Verifica 202 + enqueue no caminho
 * feliz, 422 sem PRD e 404 para demanda inexistente. O worker é mockado para
 * não spawnar o `claude` real.
 */
import express from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const demands = vi.hoisted(() => {
  const base = {
    prdUrl: null,
    tasksUrl: null,
    tddUrl: null,
    description: 'desc',
    status: 'completed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    1: { id: 1, title: 'com prd', type: 'feature', priority: 'alta', ...base },
    2: { id: 2, title: 'sem prd', type: 'feature', priority: 'media', ...base },
  } as Record<number, Record<string, unknown>>;
});

const repoMock = vi.hoisted(() => ({
  findByIdOrNull: vi.fn(async (id: number) => demands[id] ?? null),
}));

const versioningMock = vi.hoisted(() => ({
  load: vi.fn(async (id: number, type: 'prd' | 'tasks') => {
    const contentByDemand: Record<number, { prd: string; tasks: string }> = {
      1: { prd: '# PRD demanda 1\nfaça X', tasks: '# Tasks demanda 1' },
      2: { prd: '', tasks: '' },
    };
    const content = contentByDemand[id]?.[type] ?? '';
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

const enqueueMock = vi.hoisted(() => vi.fn());

vi.mock('../server/repositories/demand-repository', () => ({
  demandRepository: repoMock,
}));
vi.mock('../server/services/document-versioning', () => ({
  documentVersioningService: versioningMock,
}));
vi.mock('../server/workers/code-agent-worker', () => ({
  enqueueCodeAgentJob: enqueueMock,
  initializeCodeAgentWorker: vi.fn(),
}));

import { errorHandler } from '../server/middleware/error-handler';

describe('POST /api/demands/:id/send-to-claude (spec 10044)', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: demandsRouter } = await import('../server/routes/demands');
    app = express();
    app.use(express.json());
    app.use(demandsRouter);
    app.use(errorHandler);
  });

  beforeEach(() => {
    enqueueMock.mockClear();
  });

  it('202: enfileira o job com o spec.md como prompt (caminho feliz)', async () => {
    const res = await request(app).post('/api/demands/1/send-to-claude');

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      enqueued: true,
      demandId: 1,
      speckitPath: 'specs/1-handoff/spec.md',
    });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        demandId: 1,
        speckitPath: 'specs/1-handoff/spec.md',
        prompt: expect.stringContaining('faça X'),
      }),
    );
  });

  it('422: demanda sem PRD não enfileira', async () => {
    const res = await request(app).post('/api/demands/2/send-to-claude');
    expect(res.status).toBe(422);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('404: demanda inexistente', async () => {
    const res = await request(app).post('/api/demands/999/send-to-claude');
    expect(res.status).toBe(404);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
