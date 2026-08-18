/**
 * Testes de acesso para rotas de governança
 *
 * Autenticação foi removida (projeto local). Estes testes verificam que as
 * rotas mutáveis de governança não retornam 401/403 e que rotas de leitura
 * permanecem acessíveis.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import governanceRoutes from '../server/routes/governance-routes';

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../server/db', () => ({
  db: {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    query: {},
  },
  isPostgres: false,
}));

vi.mock('../server/repositories/demand-repository', () => ({
  demandRepository: {
    findByIdOrNull: vi.fn().mockResolvedValue({ id: 1, state: 'DRAFT' }),
    update: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../server/services/governance-service', () => ({
  submitForApproval: vi.fn().mockResolvedValue({
    snapshot: { snapshotId: 'snap-1', snapshotHash: 'hash-1' },
    approvalSessionId: 'session-1',
    gating: { valid: true },
    coverage: { score: 100 },
  }),
  updateChecklist: vi.fn().mockResolvedValue({ success: true }),
  addInteraction: vi.fn().mockResolvedValue({ success: true }),
  approveDocument: vi.fn().mockResolvedValue({ success: true }),
  rejectDemand: vi
    .fn()
    .mockResolvedValue({ documentState: 'REJECTED', rejectedAt: new Date('2026-08-07T00:00:00Z') }),
  requestChanges: vi.fn().mockResolvedValue({ success: true }),
  finalizeDocument: vi.fn().mockResolvedValue({ success: true }),
  getGatingStatus: vi.fn().mockResolvedValue({ valid: true }),
  getReviewSnapshot: vi.fn().mockResolvedValue({}),
  getApprovalComments: vi.fn().mockResolvedValue([]),
  getLifecycleEvents: vi.fn().mockResolvedValue([]),
  getGovernanceMetrics: vi.fn().mockResolvedValue({}),
  requiresHumanReview: vi.fn().mockReturnValue(false),
  getPrdContent: vi.fn().mockResolvedValue(''),
}));

vi.mock('../server/services/governance-gating-service', () => ({
  GovernanceGatingService: {
    check: vi.fn().mockResolvedValue({ valid: true }),
  },
}));

vi.mock('../server/services/document-state-machine', () => ({
  DocumentStateMachine: {
    canTransition: vi.fn().mockReturnValue(true),
  },
}));

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/governance', governanceRoutes);
  return app;
}

describe('Governance Routes (sem autenticação)', () => {
  it('rotas mutáveis não retornam 401/403 para usuário anônimo', async () => {
    const app = createApp();

    const routes = [
      { path: '/api/governance/demands/1/submit-for-approval', method: 'post', body: {} },
      { path: '/api/governance/demands/1/checklist', method: 'post', body: { checklist: {} } },
      {
        path: '/api/governance/demands/1/interactions',
        method: 'post',
        body: { type: 'COMMENT', content: 'test', author: 'test' },
      },
      {
        path: '/api/governance/demands/1/approve',
        method: 'post',
        body: { reviewSnapshotId: 'test', snapshotHash: 'test' },
      },
      {
        path: '/api/governance/demands/1/reject',
        method: 'post',
        body: { reason: 'fora do escopo' },
      },
      { path: '/api/governance/demands/1/request-changes', method: 'post', body: {} },
      { path: '/api/governance/demands/1/finalize', method: 'post', body: {} },
    ];

    for (const route of routes) {
      const response = await request(app)[route.method](route.path).send(route.body);
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
    }
  });

  it('rotas de leitura não exigem autenticação', async () => {
    const app = createApp();
    const readRoutes = [
      '/api/governance/demands/1/gating-status',
      '/api/governance/demands/1/review-snapshot',
      '/api/governance/demands/1/approval-comments',
      '/api/governance/demands/1/lifecycle-events',
      '/api/governance/metrics',
    ];

    for (const route of readRoutes) {
      const response = await request(app).get(route);
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
    }
  });
});

/**
 * A rota de rejeição só passou a existir em 2026-08-07 (triagem #10277):
 * `rejectDemand` estava no serviço, completa e testada, mas sem rota — dava
 * para aprovar uma demanda pela API e não para rejeitar.
 */
describe('POST /demands/:id/reject', () => {
  it('rejeita a demanda e devolve o estado REJECTED', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/api/governance/demands/1/reject')
      .send({ reason: 'duplicada de #10303' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, documentState: 'REJECTED' });
  });

  it('exige um motivo — rejeitar sem justificativa não é auditável', async () => {
    const app = createApp();
    const response = await request(app).post('/api/governance/demands/1/reject').send({});

    expect(response.status).toBe(400);
  });

  it('recusa motivo vazio', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/api/governance/demands/1/reject')
      .send({ reason: '' });

    expect(response.status).toBe(400);
  });
});
