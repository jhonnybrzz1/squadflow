import express from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const repoMock = vi.hoisted(() => ({
  findByIdOrNull: vi.fn(async (id: number) =>
    id === 1 ? { id: 1, title: 'demanda', type: 'produto', priority: 'alta' } : null,
  ),
  update: vi.fn(async () => undefined),
}));

vi.mock('../server/repositories/demand-repository', () => ({
  demandRepository: repoMock,
}));

import { frameworkManager } from '../server/frameworks';
import { errorHandler } from '../server/middleware/error-handler';

describe('Frameworks API (spec 013 — 5 superfícies)', () => {
  let app: express.Express;

  beforeAll(async () => {
    // Dupla init proposital: SC-004 exige contagem estável.
    await frameworkManager.initialize();
    await frameworkManager.initialize();

    const { default: systemRouter } = await import('../server/routes/system');
    const { default: demandsRouter } = await import('../server/routes/demands');
    app = express();
    app.use(express.json());
    app.use(systemRouter);
    app.use(demandsRouter);
    app.use(errorHandler);
  });

  it('1/5 lista frameworks registrados sem duplicatas (US1-AS1, SC-004)', async () => {
    const res = await request(app).get('/api/frameworks');
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(5);
    const ids = res.body.frameworks.map((f: { id: string }) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('2/5 item consultado é o mesmo da lista (US1-AS2)', async () => {
    const list = await request(app).get('/api/frameworks');
    const first = list.body.frameworks[0];
    const res = await request(app).get(`/api/frameworks/${first.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(first.id);
  });

  it('3/5 /api/frameworks/metrics não é capturada como :id (US1-AS3, FR-007)', async () => {
    const res = await request(app).get('/api/frameworks/metrics');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.metrics).toBeDefined();
  });

  it('4/5 execução persiste e retorna resultado (US2-AS1)', async () => {
    const list = await request(app).get('/api/frameworks');
    const first = list.body.frameworks[0];
    const registry = (
      frameworkManager as unknown as { registry: { get: (id: string) => { execute: unknown } } }
    ).registry;
    registry.get(first.id).execute = vi.fn(async () => ({
      frameworkId: first.id,
      frameworkName: first.name,
      demandId: 1,
      status: 'completed',
      progress: 100,
      metrics: {},
      outputs: {},
      timeline: { startedAt: new Date().toISOString() },
      teamMembers: [],
      resourcesUsed: [],
    }));

    const res = await request(app).post(`/api/demands/1/frameworks/${first.id}/execute`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.executionResult.status).toBe('completed');
    expect(repoMock.update).toHaveBeenCalled();
  });

  it('5/5 histórico contém a execução (US2-AS2, SC-003)', async () => {
    const res = await request(app).get('/api/demands/1/framework-executions');
    expect(res.status).toBe(200);
    expect(res.body.executionCount).toBeGreaterThanOrEqual(1);
  });

  it('framework inexistente na execução → 404 de domínio, não 500 (US2-AS3)', async () => {
    const res = await request(app).post('/api/demands/1/frameworks/nao-existe/execute');
    expect(res.status).toBe(404);
  });

  it('framework inexistente na consulta → 404 (US1)', async () => {
    const res = await request(app).get('/api/frameworks/nao-existe');
    expect(res.status).toBe(404);
  });
});
