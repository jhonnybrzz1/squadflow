/**
 * Demanda 10037 — rotas de artefatos pós-refinamento.
 *
 * Cobre o contrato síncrono definido pelo ADR-0002: 201 com o artefato,
 * 400 sem persistir quando o refinamento não dá para virar diagrama, 404 para
 * demanda inexistente.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../server/db', () => ({ db: {}, isPostgres: false }));

const findByIdOrNull = vi.fn();
vi.mock('../server/repositories/demand-repository', () => ({
  demandRepository: {
    findByIdOrNull: (...args: unknown[]) => findByIdOrNull(...args),
  },
}));

const loadDocumentContent = vi.fn();
vi.mock('../server/routes/demands-utils', () => ({
  loadDocumentContent: (...args: unknown[]) => loadDocumentContent(...args),
}));

const createArtifact = vi.fn();
const listByDemand = vi.fn();
vi.mock('../server/services/artifact-store', () => ({
  artifactStore: {
    create: (...args: unknown[]) => createArtifact(...args),
    listByDemand: (...args: unknown[]) => listByDemand(...args),
  },
}));

import artifactsRouter from '../server/routes/artifacts';
import { errorHandler } from '../server/middleware/error-handler';

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(artifactsRouter);
  app.use(errorHandler);
  return app;
}

const DEMAND = { id: 1, prdUrl: 'p.pdf', tasksUrl: 't.pdf', tddUrl: null };

const REFINEMENT_MD = ['### T1 — Receber demanda', '### T2 — Refinar', '### T3 — Aprovar'].join(
  '\n',
);

beforeEach(() => {
  vi.clearAllMocks();
  findByIdOrNull.mockResolvedValue(DEMAND);
  loadDocumentContent.mockReturnValue(REFINEMENT_MD);
  createArtifact.mockImplementation(async (input: { demandId: number; source: string }) => ({
    id: 'artifact-1',
    demandId: input.demandId,
    type: 'flowchart',
    source: input.source,
    createdAt: '2026-07-20T00:00:00.000Z',
  }));
  listByDemand.mockResolvedValue([]);
});

describe('POST /api/demands/:id/artifacts', () => {
  it('responde 201 com o artefato gerado (síncrono, sem jobId)', async () => {
    const res = await request(createApp())
      .post('/api/demands/1/artifacts')
      .send({ type: 'flowchart' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('artifact-1');
    expect(res.body.type).toBe('flowchart');
    expect(res.body.source).toContain('flowchart TD');
    expect(res.body.nodeCount).toBe(3);
    // ADR-0002: sem pipeline assíncrono, não existe jobId no contrato.
    expect(res.body.jobId).toBeUndefined();
  });

  it('persiste o texto Mermaid, não binário', async () => {
    await request(createApp()).post('/api/demands/1/artifacts').send({ type: 'flowchart' });

    expect(createArtifact).toHaveBeenCalledTimes(1);
    const persisted = createArtifact.mock.calls[0][0];
    expect(persisted.type).toBe('flowchart');
    expect(persisted.source).toMatch(/^flowchart TD/);
    expect(persisted.source).toContain('Receber demanda');
  });

  it('mascara PII antes de persistir', async () => {
    loadDocumentContent.mockReturnValue(
      ['1. Notificar cliente joao@empresa.com', '2. Registrar CPF 123.456.789-00'].join('\n'),
    );

    const res = await request(createApp())
      .post('/api/demands/1/artifacts')
      .send({ type: 'flowchart' });

    expect(res.status).toBe(201);
    const persisted = createArtifact.mock.calls[0][0];
    expect(persisted.source).not.toContain('joao@empresa.com');
    expect(persisted.source).not.toContain('123.456.789-00');
    expect(persisted.source).toContain('[REDACTED]');
  });

  it('responde 400 sem persistir quando o refinamento não tem processos', async () => {
    loadDocumentContent.mockReturnValue('texto corrido sem estrutura alguma');

    const res = await request(createApp())
      .post('/api/demands/1/artifacts')
      .send({ type: 'flowchart' });

    expect(res.status).toBe(400);
    expect(res.body.error?.message ?? res.body.message).toMatch(/processos/i);
    expect(createArtifact).not.toHaveBeenCalled();
  });

  it('responde 400 sem persistir quando não há documento de refinamento', async () => {
    loadDocumentContent.mockReturnValue('');

    const res = await request(createApp())
      .post('/api/demands/1/artifacts')
      .send({ type: 'flowchart' });

    expect(res.status).toBe(400);
    expect(createArtifact).not.toHaveBeenCalled();
  });

  it('responde 400 para tipo de artefato desconhecido', async () => {
    const res = await request(createApp())
      .post('/api/demands/1/artifacts')
      .send({ type: 'apresentacao-pptx' });

    expect(res.status).toBe(400);
    expect(createArtifact).not.toHaveBeenCalled();
  });

  it('responde 404 para demanda inexistente', async () => {
    findByIdOrNull.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/demands/999/artifacts')
      .send({ type: 'flowchart' });

    expect(res.status).toBe(404);
    expect(createArtifact).not.toHaveBeenCalled();
  });

  it('usa tasks como fonte preferencial do fluxograma', async () => {
    await request(createApp()).post('/api/demands/1/artifacts').send({ type: 'flowchart' });

    expect(loadDocumentContent.mock.calls[0][0]).toBe('tasks');
  });

  it('cai para o PRD quando tasks está vazio', async () => {
    loadDocumentContent.mockImplementation((type: string) =>
      type === 'tasks' ? '' : REFINEMENT_MD,
    );

    const res = await request(createApp())
      .post('/api/demands/1/artifacts')
      .send({ type: 'flowchart' });

    expect(res.status).toBe(201);
    expect(loadDocumentContent.mock.calls.map((c) => c[0])).toEqual(['tasks', 'prd']);
  });
});

describe('GET /api/demands/:id/artifacts', () => {
  it('lista os artefatos da demanda', async () => {
    listByDemand.mockResolvedValue([
      {
        id: 'a1',
        demandId: 1,
        type: 'flowchart',
        source: 'flowchart TD',
        createdAt: '2026-07-20T00:00:00.000Z',
      },
    ]);

    const res = await request(createApp()).get('/api/demands/1/artifacts');

    expect(res.status).toBe(200);
    expect(res.body.artifacts).toHaveLength(1);
    expect(res.body.artifacts[0].id).toBe('a1');
  });

  it('responde 404 para demanda inexistente', async () => {
    findByIdOrNull.mockResolvedValue(null);

    const res = await request(createApp()).get('/api/demands/999/artifacts');

    expect(res.status).toBe(404);
  });
});
