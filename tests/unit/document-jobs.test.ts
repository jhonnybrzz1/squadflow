import { beforeEach, describe, expect, it, vi } from 'vitest';

// Banco SQLite em memória simulado por um mini-armazenamento de linhas.
const rows = vi.hoisted(() => new Map<string, Record<string, unknown>>());

const dbMock = vi.hoisted(() => ({
  run: vi.fn(async (query: { queryChunks?: unknown }) => {
    const text = JSON.stringify(query);
    void text;
  }),
  all: vi.fn(async () => []),
}));

vi.mock('../../server/db', () => ({
  dbHelper: dbMock,
  isPostgres: false,
}));

import { DocumentJobsService } from '../../server/services/document-jobs';

describe('DocumentJobsService (spec 015 B2 / H-10)', () => {
  let service: DocumentJobsService;

  beforeEach(() => {
    rows.clear();
    dbMock.run.mockClear();
    dbMock.all.mockReset();
    dbMock.all.mockResolvedValue([]);
    service = new DocumentJobsService();
  });

  it('FR-005: enqueue persiste o job com status pending antes do aceite', async () => {
    const jobId = await service.enqueue(1, 'PRD', '/documents/prd_1.pdf');
    expect(jobId).toMatch(/[0-9a-f-]{36}/);
    const insert = dbMock.run.mock.calls.find((call) =>
      JSON.stringify(call[0]).includes('INSERT INTO document_jobs'),
    );
    expect(insert).toBeDefined();
    expect(JSON.stringify(insert![0])).toContain('pending');
  });

  it('FR-006: transições running→succeeded/failed atualizam status e attempts', async () => {
    await service.markRunning('job-1');
    await service.markSucceeded('job-1');
    await service.markFailed('job-2', 'boom');
    const updates = dbMock.run.mock.calls
      .map((call) => JSON.stringify(call[0]))
      .filter((text) => text.includes('UPDATE document_jobs'));
    expect(updates.length).toBe(3);
    expect(updates[0]).toContain('running');
    expect(updates[1]).toContain('succeeded');
    expect(updates[2]).toContain('failed');
    expect(updates[2]).toContain('boom');
  });

  it('SC-002: recoverOnStartup re-enfileira running órfão (1ª vez) e retorna pendentes', async () => {
    const orphan = {
      job_id: 'orphan-1',
      demand_id: 1,
      doc_type: 'PRD',
      target_filepath: '/documents/prd_1.pdf',
      status: 'running',
      attempts: 1,
      error: null,
      created_at: 1,
      updated_at: 1,
    };
    const pending = { ...orphan, job_id: 'pending-1', status: 'pending' };
    dbMock.all
      .mockResolvedValueOnce([orphan]) // SELECT running
      .mockResolvedValueOnce([pending, { ...orphan, job_id: 'orphan-1', status: 'pending' }]); // SELECT pending

    const recovered = await service.recoverOnStartup();
    expect(recovered.map((j) => j.jobId)).toContain('pending-1');

    const updates = dbMock.run.mock.calls
      .map((call) => JSON.stringify(call[0]))
      .filter((text) => text.includes('UPDATE document_jobs'));
    // Órfão com attempts < 2 volta para pending (retomada), não para failed.
    expect(updates.some((text) => text.includes('pending'))).toBe(true);
  });

  it('falha permanente: running órfão com attempts >= 2 vira failed observável (US2-AS3)', async () => {
    const orphan = {
      job_id: 'orphan-2',
      demand_id: 1,
      doc_type: 'Tasks',
      target_filepath: '/documents/tasks_1.pdf',
      status: 'running',
      attempts: 2,
      error: null,
      created_at: 1,
      updated_at: 1,
    };
    dbMock.all.mockResolvedValueOnce([orphan]).mockResolvedValueOnce([]);

    await service.recoverOnStartup();
    const updates = dbMock.run.mock.calls
      .map((call) => JSON.stringify(call[0]))
      .filter((text) => text.includes('UPDATE document_jobs'));
    expect(updates.some((t) => t.includes('failed') && t.includes('interrupted_by_restart'))).toBe(
      true,
    );
  });

  it('latestFor devolve o job mais recente para o frescor do PDF', async () => {
    dbMock.all.mockResolvedValueOnce([
      {
        job_id: 'j9',
        demand_id: 3,
        doc_type: 'PRD',
        target_filepath: '/documents/prd_3.pdf',
        status: 'failed',
        attempts: 3,
        error: 'x',
        created_at: 5,
        updated_at: 6,
      },
    ]);
    const latest = await service.latestFor(3, 'PRD');
    expect(latest?.status).toBe('failed');
    expect(latest?.updatedAt).toBe(6);
  });
});
