/**
 * Demanda 10091 — chat do agente PM com o framework injetado como contexto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const { generateChatCompletion, findBySlug } = vi.hoisted(() => ({
  generateChatCompletion: vi.fn(),
  findBySlug: vi.fn(),
}));

vi.mock('../server/services/openai-ai', () => ({
  openAIService: { generateChatCompletion },
}));

vi.mock('../server/services/pm-frameworks-service', () => ({
  pmFrameworksService: { findBySlug, list: vi.fn() },
}));

vi.mock('../server/services/ai-squad/AgentFactory', () => ({
  AgentFactory: class {
    loadConfigurations() {
      return {
        agents: [],
        agentConfigs: {
          pm_discovery: {
            system_prompt: 'Você é um PM de discovery.',
            description: 'd',
            model: 'deepseek/deepseek-v4-pro',
            model_fallback: 'mistral-medium-3.5',
          },
        },
      };
    }
  },
}));

import pmFrameworksRouter from '../server/routes/pm-frameworks-routes';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(pmFrameworksRouter);
  return app;
}

const FRAMEWORK = {
  id: 'deepsearch',
  slug: 'deepsearch',
  name: 'DeepSearch',
  description: null,
  content: '# DeepSearch\nEtapa 1: isolar o problema.',
  version: null,
  importedAt: '2026-07-23',
};

beforeEach(() => {
  generateChatCompletion.mockReset();
  findBySlug.mockReset();
});

describe('POST /api/pm-frameworks/:slug/chat', () => {
  it('injeta o conteúdo do framework no system prompt e devolve a resposta', async () => {
    findBySlug.mockResolvedValue(FRAMEWORK);
    generateChatCompletion.mockResolvedValue('Qual problema você quer investigar?');

    const res = await request(makeApp())
      .post('/api/pm-frameworks/deepsearch/chat')
      .send({ message: 'quero validar uma ideia' });

    expect(res.status).toBe(200);
    expect(res.body.reply).toContain('Qual problema');

    const [systemPrompt, userPrompt, options] = generateChatCompletion.mock.calls[0];
    // O método vai no SYSTEM (contexto), não no turno do usuário.
    expect(systemPrompt).toContain('Etapa 1: isolar o problema.');
    expect(systemPrompt).toContain('DeepSearch');
    expect(userPrompt).toContain('quero validar uma ideia');
    expect(options).toMatchObject({ agentName: 'pm_discovery', failOpenOnError: true });
  });

  it('inclui o histórico recente no prompt do usuário', async () => {
    findBySlug.mockResolvedValue(FRAMEWORK);
    generateChatCompletion.mockResolvedValue('ok');

    await request(makeApp())
      .post('/api/pm-frameworks/deepsearch/chat')
      .send({
        message: 'segunda pergunta',
        history: [
          { role: 'user', content: 'primeira' },
          { role: 'assistant', content: 'resposta anterior' },
        ],
      });

    const [, userPrompt] = generateChatCompletion.mock.calls[0];
    expect(userPrompt).toContain('primeira');
    expect(userPrompt).toContain('resposta anterior');
    expect(userPrompt).toContain('segunda pergunta');
  });

  it('404 para framework inexistente', async () => {
    findBySlug.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/pm-frameworks/nao-existe/chat')
      .send({ message: 'oi' });
    expect(res.status).toBe(404);
    expect(generateChatCompletion).not.toHaveBeenCalled();
  });

  it('400 para mensagem vazia — não gasta chamada de LLM', async () => {
    findBySlug.mockResolvedValue(FRAMEWORK);
    const res = await request(makeApp())
      .post('/api/pm-frameworks/deepsearch/chat')
      .send({ message: '   ' });
    expect(res.status).toBe(400);
    expect(generateChatCompletion).not.toHaveBeenCalled();
  });
});
