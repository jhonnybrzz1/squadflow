/**
 * Bug: GuardrailBlockError retornava 500 em /api/demands/reformulate.
 *
 * Causa raiz: `GuardrailBlockError` estende `Error`, não `AppError`, e o
 * `errorHandler` usa 500 como default para tudo que não é `AppError`. Nenhum
 * ponto do servidor tratava a classe — então o bug nunca foi específico do
 * reformulate: valia para todo endpoint que passa pelo hot path do LLM.
 *
 * Estes testes exercitam o middleware diretamente (é onde está o defeito) e
 * cobrem também os endpoints adjacentes citados na demanda.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { errorHandler, AppError } from '../server/middleware/error-handler';
import { GuardrailBlockError } from '../server/services/openai-ai';

/** App mínimo que dispara `error` na rota e delega ao errorHandler real. */
function appThrowing(error: Error, path = '/api/demands/reformulate'): express.Express {
  const app = express();
  app.use(express.json());
  app.post(path, (_req, _res, next) => next(error));
  app.get(path, (_req, _res, next) => next(error));
  app.use(errorHandler);
  return app;
}

describe('GuardrailBlockError → status HTTP', () => {
  it('bloqueio de injection responde 422, não 500', async () => {
    const error = new GuardrailBlockError(
      'Mensagem bloqueada pelos guardrails de segurança.',
      'prompt_injection',
      ['injection:ignore_previous'],
    );

    const res = await request(appThrowing(error)).post('/api/demands/reformulate').send({});

    expect(res.status).toBe(422);
    expect(res.body.error_code).toBe('GUARDRAIL_BLOCKED');
    expect(res.body.reason).toBe('prompt_injection');
  });

  it('bloqueio por PII também responde 422', async () => {
    const error = new GuardrailBlockError('Conteúdo com dados sensíveis.', 'pii_detected', [
      'pii:cpf',
    ]);

    const res = await request(appThrowing(error)).post('/api/demands/reformulate').send({});

    expect(res.status).toBe(422);
    expect(res.body.error_code).toBe('GUARDRAIL_BLOCKED');
  });

  it('devolve mensagem acionável em vez de "erro interno"', async () => {
    const error = new GuardrailBlockError(
      'Mensagem bloqueada pelos guardrails de segurança.',
      'prompt_injection',
      ['injection:ignore_previous'],
    );

    const res = await request(appThrowing(error)).post('/api/demands/reformulate').send({});

    expect(res.body.message).toBe('Mensagem bloqueada pelos guardrails de segurança.');
    expect(res.body.message).not.toMatch(/internal|interno/i);
  });

  it('expõe as detecções para o cliente explicar o bloqueio', async () => {
    const error = new GuardrailBlockError('Bloqueado.', 'prompt_injection', ['a', 'b']);

    const res = await request(appThrowing(error)).post('/api/demands/reformulate').send({});

    expect(res.body.detections).toEqual(['a', 'b']);
  });

  it('guardrail INDISPONÍVEL responde 503, não 4xx', async () => {
    // Fail-closed por indisponibilidade (spec 012/FR-009): a entrada do usuário
    // pode estar correta — quem falhou foi a verificação. Tratar como erro de
    // input culparia o usuário e esconderia um incidente de disponibilidade.
    const error = new GuardrailBlockError(
      'Não foi possível validar a segurança da mensagem.',
      'guardrails_unavailable',
      [],
    );

    const res = await request(appThrowing(error)).post('/api/demands/reformulate').send({});

    expect(res.status).toBe(503);
    expect(res.body.error_code).toBe('GUARDRAIL_UNAVAILABLE');
  });

  it('vale para endpoints adjacentes, não só o reformulate', async () => {
    const paths = ['/api/demands/1/chat', '/api/demands', '/api/refinement/unified'];

    for (const path of paths) {
      const error = new GuardrailBlockError('Bloqueado.', 'prompt_injection', ['x']);
      const res = await request(appThrowing(error, path)).post(path).send({});
      expect(res.status).toBe(422);
    }
  });
});

describe('regressão: demais erros não mudaram de status', () => {
  it('erro genérico continua 500', async () => {
    const res = await request(appThrowing(new Error('boom')))
      .post('/api/demands/reformulate')
      .send({});

    expect(res.status).toBe(500);
  });

  it('AppError preserva o próprio statusCode', async () => {
    const res = await request(appThrowing(new AppError('timeout', 408, 'REQUEST_TIMEOUT')))
      .post('/api/demands/reformulate')
      .send({});

    expect(res.status).toBe(408);
  });

  it('erro com isGuardrailBlock malformado não é tratado como guardrail', async () => {
    // Proteção do duck-typing: só o formato completo entra no caminho novo.
    const impostor = Object.assign(new Error('falso'), { isGuardrailBlock: true });

    const res = await request(appThrowing(impostor)).post('/api/demands/reformulate').send({});

    expect(res.status).toBe(500);
  });
});
