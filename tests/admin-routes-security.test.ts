/**
 * Testes de acesso para rotas administrativas do sistema
 *
 * Autenticação foi removida (projeto roda apenas localmente). Estes testes
 * verificam que os endpoints destrutivos continuam acessíveis e que o log
 * de auditoria usa a identidade local fixa.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import systemRoutes from '../server/routes/system';
import metricsRoutes from '../server/routes/metrics';

vi.mock('../server/services/ai-usage-tracker', () => ({
  aiUsageTracker: {
    reset: vi.fn(),
    getSummary: vi.fn(() => ({ recent: [] })),
  },
}));

vi.mock('../server/services/ai-cache', () => ({
  aiResponseCache: {
    clear: vi.fn(),
    getStats: vi.fn(() => ({ size: 0, hits: 0, misses: 0 })),
  },
}));

vi.mock('../server/services/circuit-breaker', () => ({
  circuitBreaker: {
    reset: vi.fn(),
    getAllStats: vi.fn(() => ({})),
  },
}));

vi.mock('../metrics/collector', () => ({
  perfMetricsCollector: {
    clear: vi.fn(),
    exportBaseline: vi.fn(() => ({})),
  },
}));

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Admin Routes (sem autenticação)', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(systemRoutes);
    app.use(metricsRoutes);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/ai/usage/reset', () => {
    it('deve retornar 200 sem token admin', async () => {
      const response = await request(app).post('/api/ai/usage/reset');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ success: true });
    });
  });

  describe('POST /api/ai/cache/clear', () => {
    it('deve retornar 200 sem token admin', async () => {
      const response = await request(app).post('/api/ai/cache/clear');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ success: true });
    });
  });

  describe('POST /api/ai/circuit-breaker/:service/reset', () => {
    it('deve retornar 200 sem token admin', async () => {
      const response = await request(app).post('/api/ai/circuit-breaker/test-service/reset');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ success: true, service: 'test-service' });
    });
  });

  describe('POST /api/metrics/performance/clear', () => {
    it('deve retornar 200 sem token admin', async () => {
      const response = await request(app).post('/api/metrics/performance/clear');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ message: 'Metrics cleared' });
    });
  });

  describe('Rotas de leitura permanecem acessíveis', () => {
    it('GET /api/ai/usage deve ser acessível', async () => {
      const response = await request(app).get('/api/ai/usage');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('usage');
    });

    it('GET /api/ai/circuit-breaker deve ser acessível', async () => {
      const response = await request(app).get('/api/ai/circuit-breaker');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('circuits');
    });

    it('GET /api/metrics/performance deve ser acessível', async () => {
      const response = await request(app).get('/api/metrics/performance');
      expect(response.status).toBe(200);
    });
  });

  describe('Logging de auditoria', () => {
    it('deve registrar log de auditoria para ações admin com identidade local', async () => {
      const { logger } = await import('../server/utils/logger');

      const response = await request(app).post('/api/ai/usage/reset');
      expect(response.status).toBe(200);

      expect(logger.info).toHaveBeenCalledWith(
        'Admin action executed',
        expect.objectContaining({
          context: expect.objectContaining({
            action: 'resetAI',
            adminId: 'local-user',
            adminRole: 'admin',
            adminName: 'Local User',
            isAuthenticated: true,
            timestamp: expect.any(String),
            success: true,
          }),
        }),
      );
    });

    it('deve incluir IP anonimizado no log de auditoria', async () => {
      const { logger } = await import('../server/utils/logger');

      await request(app).post('/api/ai/cache/clear');

      const logCall = logger.info.mock.calls.find(
        (call) => call[0] === 'Admin action executed' && call[1]?.context?.action === 'clearCache',
      );
      expect(logCall).toBeDefined();
      expect(logCall[1].context.ip).toMatch(/\.x$/);
    });
  });
});
