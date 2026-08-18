/**
 * Demanda 10028 (T008) — integração de POST /api/demands/reformulate: valida
 * o contrato HTTP (Zod do request), a passagem do payload estendido para
 * `reformulateDemand`, e a regressão do payload legado (`{ draft }` apenas).
 * A lógica de RAG/prompt já está coberta em tests/unit/demand-reformulation.test.ts.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reformulateDemandMock = vi.hoisted(() => vi.fn());

vi.mock('../server/services/demand-reformulation', () => ({
  reformulateDemand: reformulateDemandMock,
}));

import { errorHandler } from '../server/middleware/error-handler';
import { GuardrailBlockError } from '../server/services/openai-ai';

const VALID_RESULT = {
  descricao_reformulada: 'Descrição profissional.',
  criterios_aceite: [],
  regras_negocio: [],
  limitacoes_escopo: [],
  slas: [],
  contractFields: {},
  sem_contexto_repo: true,
};

describe('POST /api/demands/reformulate (demanda 10028)', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    reformulateDemandMock.mockResolvedValue(VALID_RESULT);
    const { default: demandsRouter } = await import('../server/routes/demands');
    app = express();
    app.use(express.json());
    app.use(demandsRouter);
    app.use(errorHandler);
  });

  it('regressão: payload legado ({ draft }) continua funcionando (200)', async () => {
    const res = await request(app)
      .post('/api/demands/reformulate')
      .send({ draft: 'rascunho suficientemente longo' });

    expect(res.status).toBe(200);
    expect(reformulateDemandMock).toHaveBeenCalledWith(
      expect.objectContaining({ draft: 'rascunho suficientemente longo' }),
    );
  });

  it('200 e repassa repoFullName/type/domain/additionalRepos ao service (SC-001/SC-003)', async () => {
    const res = await request(app)
      .post('/api/demands/reformulate')
      .send({
        draft: 'rascunho suficientemente longo sobre exportação de dados',
        title: 'Exportar dados',
        type: 'nova_funcionalidade',
        domain: 'padrao',
        repoFullName: 'org/repo',
        additionalRepos: ['org/repo2'],
        refinementType: 'technical',
      });

    expect(res.status).toBe(200);
    expect(reformulateDemandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: 'org/repo',
        additionalRepos: ['org/repo2'],
        type: 'nova_funcionalidade',
        refinementType: 'technical',
      }),
    );
  });

  it('400 quando refinementType não está no enum permitido', async () => {
    const res = await request(app)
      .post('/api/demands/reformulate')
      .send({ draft: 'rascunho longo o suficiente', refinementType: 'invalido' });

    expect(res.status).toBe(400);
    expect(reformulateDemandMock).not.toHaveBeenCalled();
  });

  it('400 quando draft está ausente', async () => {
    const res = await request(app).post('/api/demands/reformulate').send({});

    expect(res.status).toBe(400);
    expect(reformulateDemandMock).not.toHaveBeenCalled();
  });

  it('propaga sem_contexto_repo e contractFields da resposta do service', async () => {
    reformulateDemandMock.mockResolvedValue({
      ...VALID_RESULT,
      title: 'Título gerado',
      contractFields: { feature_user: 'Analista' },
      sem_contexto_repo: false,
    });

    const res = await request(app)
      .post('/api/demands/reformulate')
      .send({ draft: 'rascunho longo o suficiente', repoFullName: 'org/repo' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Título gerado');
    expect(res.body.contractFields).toEqual({ feature_user: 'Analista' });
    expect(res.body.sem_contexto_repo).toBe(false);
  });

  it('408 quando o service lança timeout (regressão do comportamento US1 AC4)', async () => {
    const { AppError } = await import('../server/middleware/error-handler');
    reformulateDemandMock.mockRejectedValue(
      new AppError('Reformulação excedeu o tempo limite', 408, 'REQUEST_TIMEOUT'),
    );

    const res = await request(app)
      .post('/api/demands/reformulate')
      .send({ draft: 'rascunho longo o suficiente' });

    expect(res.status).toBe(408);
  });

  it('422 quando o service lança GuardrailBlockError bloqueado (spec 10051)', async () => {
    reformulateDemandMock.mockRejectedValue(
      new GuardrailBlockError(
        'Sua mensagem não pôde ser processada. Reformule.',
        'prompt_injection',
        ['injection'],
      ),
    );

    const res = await request(app)
      .post('/api/demands/reformulate')
      .send({ draft: 'rascunho longo o suficiente' });

    expect(res.status).toBe(422);
    expect(res.body.error_code).toBe('GUARDRAIL_BLOCKED');
    expect(res.body.message).toBe('Sua mensagem não pôde ser processada. Reformule.');
  });

  it('503 quando o service lança GuardrailBlockError guardrails_unavailable (spec 10051)', async () => {
    reformulateDemandMock.mockRejectedValue(
      new GuardrailBlockError(
        'Os guardrails de segurança estão indisponíveis. Tente novamente mais tarde.',
        'guardrails_unavailable',
        [],
      ),
    );

    const res = await request(app)
      .post('/api/demands/reformulate')
      .send({ draft: 'rascunho longo o suficiente' });

    expect(res.status).toBe(503);
    expect(res.body.error_code).toBe('GUARDRAIL_UNAVAILABLE');
  });
});
