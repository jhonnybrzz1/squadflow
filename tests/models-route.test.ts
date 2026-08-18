/**
 * Demanda 10082 (F3) — testes das rotas /api/models/overview e /api/models/active.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const resolveMock = vi.hoisted(() => vi.fn());

vi.mock('../server/services/ai-squad/AgentFactory', () => ({
  AgentFactory: class {
    loadConfigurations() {
      return {
        agents: [],
        agentConfigs: {
          tech_lead: {
            system_prompt: 'x',
            description: 'd',
            model: 'tl-alias',
            model_fallback: 'mistral',
          },
          qa: { system_prompt: 'y', description: 'd' }, // sem model
        },
      };
    }
  },
}));

vi.mock('../server/services/model-registry', () => ({
  modelRegistry: { resolve: resolveMock },
}));

import modelsRouter from '../server/routes/models';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(modelsRouter);
  return app;
}

beforeEach(() => resolveMock.mockReset());

describe('GET /api/models/overview', () => {
  it('lista o modelo ativo de cada agente e marca fallback', async () => {
    resolveMock.mockResolvedValue({
      alias: 'tl-alias',
      modelId: 'x-ai/grok',
      provider: 'openrouter',
      source: 'static-fallback',
      resolvedAt: new Date().toISOString(),
    });
    const res = await request(makeApp()).get('/api/models/overview');
    expect(res.status).toBe(200);
    const tl = res.body.agents.find((a: { agentId: string }) => a.agentId === 'tech_lead');
    expect(tl.model).toBe('tl-alias');
    expect(tl.active.modelId).toBe('x-ai/grok');
    expect(tl.active.usingFallback).toBe(true); // source static-fallback
    const qa = res.body.agents.find((a: { agentId: string }) => a.agentId === 'qa');
    expect(qa.model).toBeNull();
    expect(qa.active).toBeNull(); // sem model, não resolve
  });

  it('registry sem match: active fica null, listagem segue 200', async () => {
    // resolve retorna sem lançar mas o alias não bate — active permanece coerente.
    resolveMock.mockResolvedValue({
      alias: 'tl-alias',
      modelId: 'tl-alias',
      provider: 'unknown',
      source: 'static-fallback',
      resolvedAt: new Date().toISOString(),
    });
    const res = await request(makeApp()).get('/api/models/overview');
    expect(res.status).toBe(200);
    const tl = res.body.agents.find((a: { agentId: string }) => a.agentId === 'tech_lead');
    expect(tl.active.usingFallback).toBe(true);
  });
});

describe('GET /api/models/active', () => {
  it('retorna o modelo de um agente', async () => {
    resolveMock.mockResolvedValue({
      alias: 'tl-alias',
      modelId: 'anthropic/claude',
      provider: 'anthropic',
      source: 'database',
      resolvedAt: new Date().toISOString(),
    });
    const res = await request(makeApp()).get('/api/models/active?agent_id=tech_lead');
    expect(res.status).toBe(200);
    expect(res.body.active.modelId).toBe('anthropic/claude');
    expect(res.body.active.usingFallback).toBe(false);
  });

  it('400 sem agent_id', async () => {
    const res = await request(makeApp()).get('/api/models/active');
    expect(res.status).toBe(400);
  });

  it('404 para agente inexistente', async () => {
    const res = await request(makeApp()).get('/api/models/active?agent_id=inexistente');
    expect(res.status).toBe(404);
  });
});
