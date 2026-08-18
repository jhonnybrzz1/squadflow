/**
 * Regressão: as rotas literais de retention-policies (/logs, /db-metrics,
 * /scheduler-status, /simulate-all) NÃO podem ser capturadas pelo
 * `/retention-policies/:id`. Antes, `:id` estava registrado primeiro e o
 * `z.coerce.number()` de policyIdSchema devolvia 400 para "logs"/"db-metrics"/…
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../server/services/retention-policy', () => ({
  retentionPolicyService: {
    getJobLogs: vi.fn(async () => []),
    getDbSizeMetrics: vi.fn(async () => ({ totalMb: 1 })),
    simulateAllPolicies: vi.fn(async () => []),
    getPolicyById: vi.fn(async (id: number) => ({ id, dataType: 'x', ttlDays: 30 })),
    getAllPolicies: vi.fn(async () => []),
  },
}));

vi.mock('../server/workers/retention-worker', () => ({
  retentionWorker: {
    isSchedulerRunning: vi.fn(() => false),
    isJobRunning: vi.fn(() => false),
    runCleanup: vi.fn(),
    startScheduler: vi.fn(),
    stopScheduler: vi.fn(),
  },
}));

vi.mock('../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('admin retention-policies — ordem de rotas (regressão dos 400)', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    const adminRouter = (await import('../server/routes/admin')).default;
    app = express();
    app.use(express.json());
    app.use('/api/admin', adminRouter);
  });

  it.each([
    ['/api/admin/retention-policies/logs'],
    ['/api/admin/retention-policies/db-metrics'],
    ['/api/admin/retention-policies/scheduler-status'],
    ['/api/admin/retention-policies/simulate-all'],
  ])('GET %s não é capturado por :id (sem 400)', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
  });

  it('GET /retention-policies/:id numérico ainda roteia para o handler de id', async () => {
    const res = await request(app).get('/api/admin/retention-policies/42');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 42 });
  });
});
