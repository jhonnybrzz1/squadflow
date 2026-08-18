import express from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const repoMock = vi.hoisted(() => ({
  findById: vi.fn(async () => ({ id: 1, title: 'Demanda X' })),
  findByIdOrNull: vi.fn(async () => ({ id: 1, title: 'Demanda X' })),
  findAll: vi.fn(async () => []),
}));

const exportMock = vi.hoisted(() => ({
  export: vi.fn(async () => ({ ok: true, status: 'success', externalUrl: 'http://doc/1' })),
  listForDemand: vi.fn(async () => []),
}));

const probeMock = vi.hoisted(() =>
  vi.fn(async () => ({ online: true, url: 'http://localhost:3000' })),
);

vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: repoMock,
}));

vi.mock('../../server/services/docusmente-export', () => ({
  docuMenteExportService: exportMock,
}));

vi.mock('../../server/services/documente-health', () => ({
  probeDocuMente: probeMock,
}));

vi.mock('../../server/services/governance-service', () => ({
  getPrdContent: vi.fn(async () => '# PRD sintetico para exportacao'),
}));

vi.mock('../../server/services/classifier-observability', () => ({
  recordClassifierSubmission: vi.fn(),
}));

import { errorHandler } from '../../server/middleware/error-handler';

describe('Destino DocuMente controlado pelo servidor (spec 011 / R-02 + H-03)', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: demandsRouter } = await import('../../server/routes/demands');
    app = express();
    app.use(express.json());
    app.use(demandsRouter);
    app.use(errorHandler);
  });

  it('H-03: a rota vive no caminho consumido pela UI (/api/demands/:id/export-documente)', async () => {
    const res = await request(app)
      .post('/api/demands/1/export-documente')
      .send({ docType: 'epic' });
    expect(res.status).toBe(200);
    expect(exportMock.export).toHaveBeenCalled();
  });

  it('US3-AS2: URL alternativa no corpo é IGNORADA — credencial nunca vai ao host do cliente', async () => {
    exportMock.export.mockClear();
    const res = await request(app)
      .post('/api/demands/1/export-documente')
      .send({ docType: 'epic', docuMenteUrl: 'https://atacante.example' });
    expect(res.status).toBe(200);
    const args = exportMock.export.mock.calls[0][0] as { docuMenteUrl: string };
    expect(args.docuMenteUrl).toBe('http://localhost:3000');
    expect(args.docuMenteUrl).not.toContain('atacante');
  });

  it('sem destino configurado online, a exportação falha com erro claro', async () => {
    probeMock.mockResolvedValueOnce({ online: false, url: null });
    const res = await request(app)
      .post('/api/demands/1/export-documente')
      .send({ docType: 'epic' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
