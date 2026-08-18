/**
 * Spec 019 — GET /api/documents/:filename entrega o nome real (legível) no
 * Content-Disposition em vez de PRD_{timestamp}, para pdf/docx/txt, mantendo
 * o guard de path traversal.
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { errorHandler } from '../server/middleware/error-handler';

const documentsDir = path.join(process.cwd(), 'documents');
const fixtures = [
  'Dashboard_Vendas_Q3_PRD.pdf',
  'Dashboard_Vendas_Q3_Tasks.docx',
  'Dashboard_Vendas_Q3_PRD.txt',
] as const;

describe('GET /api/documents/:filename (spec 019)', () => {
  let app: express.Express;

  beforeAll(async () => {
    fs.mkdirSync(documentsDir, { recursive: true });
    for (const name of fixtures) {
      fs.writeFileSync(path.join(documentsDir, name), `conteudo de teste ${name}`);
    }
    const { default: systemRouter } = await import('../server/routes/system');
    app = express();
    app.use(systemRouter);
    app.use(errorHandler);
  });

  afterAll(() => {
    for (const name of fixtures) {
      fs.rmSync(path.join(documentsDir, name), { force: true });
    }
  });

  it('PDF: Content-Disposition usa o basename real, sem timestamp (RF-01)', async () => {
    const res = await request(app).get('/api/documents/Dashboard_Vendas_Q3_PRD.pdf');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="Dashboard_Vendas_Q3_PRD.pdf"',
    );
  });

  it('DOCX e TXT seguem a mesma regra de nome', async () => {
    const docx = await request(app).get('/api/documents/Dashboard_Vendas_Q3_Tasks.docx');
    expect(docx.headers['content-disposition']).toBe(
      'attachment; filename="Dashboard_Vendas_Q3_Tasks.docx"',
    );

    const txt = await request(app).get('/api/documents/Dashboard_Vendas_Q3_PRD.txt');
    expect(txt.headers['content-disposition']).toBe(
      'attachment; filename="Dashboard_Vendas_Q3_PRD.txt"',
    );
  });

  it('nenhum header de download contém padrão de timestamp (regressão do bug)', async () => {
    const res = await request(app).get('/api/documents/Dashboard_Vendas_Q3_PRD.pdf');
    expect(res.headers['content-disposition']).not.toMatch(/PRD_\d{10,}/);
  });

  it('404 para documento inexistente', async () => {
    const res = await request(app).get('/api/documents/nao-existe_PRD.pdf');
    expect(res.status).toBe(404);
  });

  it('guard de path traversal permanece ativo', async () => {
    const res = await request(app).get('/api/documents/..%2F..%2Fetc%2Fpasswd');
    expect([400, 403, 404]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });
});
