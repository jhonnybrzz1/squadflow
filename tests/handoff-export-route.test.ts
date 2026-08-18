/**
 * Spec 018 — integração da rota GET /api/demands/:id/export/bundle
 * (T007: 200/404/400 + regressão dos exports irmãos; T009: casos 422;
 *  T011: telemetria handoff_bundle_*).
 * Contrato: specs/018-handoff-export-bundle/contracts/export-bundle.md
 */
import express from 'express';
import JSZip from 'jszip';
import request, { type Response as SupertestResponse } from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const demands = vi.hoisted(() => {
  const base = {
    prdUrl: null,
    tasksUrl: null,
    tddUrl: null,
    description: 'desc',
    status: 'completed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    chatMessages: [
      { agent: 'pm', message: 'olá', timestamp: Date.now(), type: 'completed' as const },
    ],
  };
  return {
    1: { id: 1, title: 'com prd e tasks', type: 'feature', priority: 'alta', ...base },
    2: { id: 2, title: 'sem prd', type: 'feature', priority: 'media', ...base },
    3: { id: 3, title: 'prd em pdf-bytes', type: 'feature', priority: 'baixa', ...base },
  } as Record<number, Record<string, unknown>>;
});

const repoMock = vi.hoisted(() => ({
  findByIdOrNull: vi.fn(async (id: number) => demands[id] ?? null),
}));

const versioningMock = vi.hoisted(() => ({
  load: vi.fn(async (id: number, type: 'prd' | 'tasks') => {
    const contentByDemand: Record<number, { prd: string; tasks: string }> = {
      1: { prd: '# PRD demanda 1', tasks: '# Tasks demanda 1' },
      2: { prd: '', tasks: '' },
      3: { prd: '%PDF-1.7 binário', tasks: '' },
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

vi.mock('../server/repositories/demand-repository', () => ({
  demandRepository: repoMock,
}));

vi.mock('../server/services/document-versioning', () => ({
  documentVersioningService: versioningMock,
}));

import { handoffBundleFailureTotal, handoffBundleTotal } from '../server/metrics';
import { errorHandler } from '../server/middleware/error-handler';

function binaryParser(
  res: NodeJS.ReadableStream,
  callback: (err: Error | null, body: Buffer) => void,
) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

async function counterValue(): Promise<number> {
  const metric = await handoffBundleTotal.get();
  return metric.values[0]?.value ?? 0;
}

async function failureValue(reason: string): Promise<number> {
  const metric = await handoffBundleFailureTotal.get();
  return metric.values.find((v) => v.labels.reason === reason)?.value ?? 0;
}

describe('GET /api/demands/:id/export/bundle (spec 018)', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: demandsRouter } = await import('../server/routes/demands');
    app = express();
    app.use(express.json());
    app.use(demandsRouter);
    app.use(errorHandler);
  });

  function getBundle(id: number | string): Promise<SupertestResponse> {
    return request(app).get(`/api/demands/${id}/export/bundle`).buffer(true).parse(binaryParser);
  }

  it('200: entrega zip com headers e as 4 entradas do layout spec-kit (US1-AS1, FR-001)', async () => {
    const before = await counterValue();
    const res = await getBundle(1);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="demanda-1-handoff.zip"');

    const zip = await JSZip.loadAsync(res.body as Buffer);
    const paths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
    expect(paths.sort()).toEqual(
      [
        '.specify/memory/constitution.md',
        'manifest.json',
        'specs/1-handoff/spec.md',
        'specs/1-handoff/tasks.md',
      ].sort(),
    );

    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.format).toBe('aichatflow-handoff/v1');
    expect(manifest.demand.id).toBe(1);

    // T011: sucesso conta em handoff_bundle_total
    expect(await counterValue()).toBe(before + 1);
  });

  it('404: demanda inexistente, com telemetria not_found (US2-AS4, FR-004)', async () => {
    const before = await failureValue('not_found');
    const res = await getBundle(999999);
    expect(res.status).toBe(404);
    expect(await failureValue('not_found')).toBe(before + 1);
  });

  it('400: id inválido é barrado pelo paramIdSchema sem telemetria de handoff', async () => {
    const beforeFailures = await handoffBundleFailureTotal.get();
    const res = await request(app).get('/api/demands/abc/export/bundle');
    expect(res.status).toBe(400);
    const afterFailures = await handoffBundleFailureTotal.get();
    expect(afterFailures.values).toEqual(beforeFailures.values);
  });

  it('422: demanda sem PRD — mensagem clara, code HANDOFF_PRD_MISSING, sem zip (US2-AS2, FR-003)', async () => {
    const before = await failureValue('prd_missing');
    const res = await request(app).get('/api/demands/2/export/bundle');

    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.errorCode).toBe('HANDOFF_PRD_MISSING');
    expect(res.body.message).toContain('PRD ausente ou vazio');

    // T011: falha conta em handoff_bundle_failure_total{reason="prd_missing"}
    expect(await failureValue('prd_missing')).toBe(before + 1);
  });

  it('422: PRD com bytes de PDF é tratado como ausente (US2-AS3, FR-003)', async () => {
    const res = await request(app).get('/api/demands/3/export/bundle');
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('HANDOFF_PRD_MISSING');
  });

  it('regressão: export/json e export/txt continuam respondendo (FR-012)', async () => {
    const jsonRes = await request(app).get('/api/demands/1/export/json');
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.body.demandId).toBe(1);
    expect(jsonRes.body.chatHistory).toHaveLength(1);

    const txtRes = await request(app).get('/api/demands/1/export/txt');
    expect(txtRes.status).toBe(200);
    expect(txtRes.headers['content-type']).toContain('text/plain');
    expect(txtRes.text).toContain('HISTÓRICO DE DIÁLOGO - DEMANDA #1');
  });
});
