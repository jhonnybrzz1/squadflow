/**
 * CRIT-7: GET /api/demands/:id/events não deve refletir
 * `Access-Control-Allow-Origin: *` — qualquer site poderia abrir um
 * EventSource e ler dados de processamento em tempo real (progresso,
 * mensagens dos agentes, PRD). O header só deve ser refletido para uma
 * origem presente na allowlist compartilhada com o WebSocket.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const demandRepositoryMock = vi.hoisted(() => ({
  findByIdOrNull: vi.fn(),
}));

const sseManagerMock = vi.hoisted(() => ({
  addConnection: vi.fn((_id: number, res: { end: () => void }) => {
    // Encerra a conexão imediatamente para o request de teste resolver
    // (a rota real nunca chama res.end() — a conexão fica aberta até o
    // cliente desconectar).
    res.end();
    return 'connection-1';
  }),
  sendStarted: vi.fn(),
  sendProcessing: vi.fn(),
  sendProgress: vi.fn(),
  sendError: vi.fn(),
  removeConnection: vi.fn(),
}));

vi.mock('../server/repositories/demand-repository', () => ({
  demandRepository: demandRepositoryMock,
}));

vi.mock('../server/services/ai-squad', () => ({ aiSquadService: {} }));
vi.mock('../server/cognitive-core', () => ({ demandClassifier: {}, agentOrchestrator: {} }));
vi.mock('../server/frameworks', () => ({ frameworkManager: {} }));
vi.mock('../server/services/llm-audit-log', () => ({ llmAuditLogService: {} }));
vi.mock('../server/services/agent-jobs', () => ({ agentJobsService: {} }));
vi.mock('../server/services/model-routing', () => ({
  modelRoutingService: { getDemandStageRuns: vi.fn() },
}));
vi.mock('../server/services/refinement-input', () => ({ resolveRefinementInput: vi.fn() }));
vi.mock('../server/services/repo-service', () => ({ repoService: {} }));
vi.mock('../server/services/sse', () => ({ sseManager: sseManagerMock }));
vi.mock('../server/storage', () => ({
  storage: { createFile: vi.fn(), getFilesByDemandId: vi.fn(), getFile: vi.fn() },
}));
vi.mock('../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import demandsRouter from '../server/routes/demands';
import { errorHandler } from '../server/middleware/error-handler';
import { webSocketOriginPolicy } from '../server/services/websocket/origin-policy';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(demandsRouter);
  app.use(errorHandler);
  return app;
}

describe('GET /api/demands/:id/events — CORS (CRIT-7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    demandRepositoryMock.findByIdOrNull.mockResolvedValue({ id: 7, status: 'processing' });
  });

  it('nunca reflete o wildcard "*"', async () => {
    const response = await request(createApp())
      .get('/api/demands/7/events')
      .set('Origin', 'https://evil.example.com');

    expect(response.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('não seta o header para uma origem fora da allowlist', async () => {
    const response = await request(createApp())
      .get('/api/demands/7/events')
      .set('Origin', 'https://evil.example.com');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('não seta o header quando a requisição não envia Origin (uso normal same-origin)', async () => {
    const response = await request(createApp()).get('/api/demands/7/events');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reflete o header (com Vary: Origin) para uma origem na allowlist', async () => {
    // Mesma allowlist usada pelo upgrade do WebSocket (setActualPort é
    // chamado após server.listen em produção; aqui simulamos a porta real).
    webSocketOriginPolicy.setActualPort(4321);

    const response = await request(createApp())
      .get('/api/demands/7/events')
      .set('Origin', 'http://localhost:4321');

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:4321');
    expect(response.headers.vary).toBe('Origin');
  });
});
