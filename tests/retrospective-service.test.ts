/**
 * Demanda 10078 — módulo de retrospectiva automatizada.
 *
 * SQLite real (`:memory:`) para `retrospective_sessions` — não mocka o banco
 * que este teste está introduzindo (ver memória "testes mockam banco —
 * cegueira a schema"). Só a fronteira LLM (`openAIService`) e a fonte de
 * demandas (`demandRepository`) são mockadas.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@shared/schema';
import type { Demand } from '@shared/schema';

vi.mock('../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { generateChatCompletion, generateJSONResponse, findAll } = vi.hoisted(() => ({
  generateChatCompletion: vi.fn(),
  generateJSONResponse: vi.fn(),
  findAll: vi.fn(),
}));

vi.mock('../server/services/openai-ai', () => ({
  openAIService: { generateChatCompletion, generateJSONResponse },
}));

vi.mock('../server/repositories/demand-repository', () => ({
  demandRepository: { findAll },
}));

import {
  RETROSPECTIVE_SESSIONS_CREATE_STATEMENTS,
  retrospectiveService,
  __setRetrospectiveRunnerForTests,
} from '../server/services/retrospective-service';

function makeRunner(sqlite: Database.Database) {
  const db = drizzle(sqlite, { schema });
  return {
    run: (q: ReturnType<typeof sql>) => db.run(q),
    all: <T>(q: ReturnType<typeof sql>) => db.all(q) as T[],
  };
}

function buildDemand(overrides: Partial<Demand> = {}): Demand {
  return {
    id: 1,
    title: 'Demanda de teste',
    description: 'desc',
    type: 'melhoria',
    priority: 'media',
    status: 'completed',
    progress: 100,
    chatMessages: [],
    domain: 'padrao',
    errorMessage: null,
    validationNotes: null,
    learningLog: [],
    repoFullName: 'org/repo',
    // Data FIXA dentro do período do teste (2026-07-01..07-23). Antes era
    // `new Date()`, que fazia o teste quebrar a partir de 2026-07-24, quando
    // o "agora" passa a cair fora da janela e o filtro descarta as demandas.
    createdAt: new Date('2026-07-15T12:00:00.000Z'),
    ...overrides,
  } as unknown as Demand;
}

describe('Spec 10078 — retrospective_sessions schema', () => {
  it('cria a tabela idempotentemente com todas as colunas', () => {
    const sqlite = new Database(':memory:');
    for (const s of RETROSPECTIVE_SESSIONS_CREATE_STATEMENTS) sqlite.exec(s);
    for (const s of RETROSPECTIVE_SESSIONS_CREATE_STATEMENTS) sqlite.exec(s); // idempotente

    const cols = (
      sqlite.prepare("PRAGMA table_info('retrospective_sessions')").all() as Array<{ name: string }>
    ).map((c) => c.name);

    for (const expected of [
      'id',
      'period_start',
      'period_end',
      'status',
      'summary',
      'insights',
      'demands_analyzed',
      'agent_participants',
      'error_message',
      'started_at',
      'completed_at',
      'created_at',
    ]) {
      expect(cols).toContain(expected);
    }
    sqlite.close();
  });
});

describe('Spec 10078 — RetrospectiveService.run', () => {
  let active: Database.Database | null = null;

  afterEach(() => {
    __setRetrospectiveRunnerForTests(null);
    active?.close();
    active = null;
    vi.clearAllMocks();
  });

  it('roda o ciclo completo e persiste summary/insights com status completed', async () => {
    const sqlite = new Database(':memory:');
    active = sqlite;
    __setRetrospectiveRunnerForTests(makeRunner(sqlite));

    findAll.mockResolvedValue([
      buildDemand({ id: 10, status: 'completed', repoFullName: 'org/repo' }),
      buildDemand({
        id: 11,
        status: 'error',
        errorMessage: 'timeout na LLM',
        repoFullName: 'org/repo',
      }),
    ]);
    generateChatCompletion.mockResolvedValue('- ponto de atenção X\n- oportunidade Y');
    generateJSONResponse.mockResolvedValue({
      summary: 'Sessão 1: squad estável, um timeout isolado.',
      insights: ['Monitorar timeouts da LLM', 'Repo org/repo concentra o volume'],
    });

    const { id } = await retrospectiveService.start('2026-07-01', '2026-07-23');
    // start() dispara run() sem await (fire-and-forget) — aguarda a conclusão.
    await vi.waitFor(async () => {
      const session = await retrospectiveService.findById(id);
      expect(session?.status).toBe('completed');
    });

    const session = await retrospectiveService.findById(id);
    expect(session?.summary).toBe('Sessão 1: squad estável, um timeout isolado.');
    expect(session?.insights).toEqual([
      'Monitorar timeouts da LLM',
      'Repo org/repo concentra o volume',
    ]);
    expect(session?.demandsAnalyzed).toEqual([10, 11]);
    expect(session?.agentParticipants).toEqual(
      expect.arrayContaining(['tech_lead', 'qa', 'product_owner', 'scrum_master']),
    );
  });

  it('T6: sessão seguinte lê o resumo/insights da sessão anterior (memória ativa)', async () => {
    const sqlite = new Database(':memory:');
    active = sqlite;
    __setRetrospectiveRunnerForTests(makeRunner(sqlite));

    findAll.mockResolvedValue([buildDemand({ id: 20 })]);
    generateChatCompletion.mockResolvedValue('- análise genérica');
    generateJSONResponse.mockResolvedValueOnce({
      summary: 'INSIGHT_ÚNICO_DA_SESSAO_1',
      insights: ['aprendizado-marcador-sessao-1'],
    });

    const first = await retrospectiveService.start('2026-06-01', '2026-06-07');
    await vi.waitFor(async () => {
      const session = await retrospectiveService.findById(first.id);
      expect(session?.status).toBe('completed');
    });

    generateJSONResponse.mockResolvedValueOnce({
      summary: 'Sessão 2',
      insights: ['novo aprendizado'],
    });

    await retrospectiveService.start('2026-06-08', '2026-06-14');
    await vi.waitFor(() => {
      expect(generateJSONResponse).toHaveBeenCalledTimes(2);
    });

    const secondSynthesisPrompt = generateJSONResponse.mock.calls[1][1] as string;
    expect(secondSynthesisPrompt).toContain('INSIGHT_ÚNICO_DA_SESSAO_1');
    expect(secondSynthesisPrompt).toContain('aprendizado-marcador-sessao-1');
  });

  it('marca a sessão como failed quando uma chamada LLM falha', async () => {
    const sqlite = new Database(':memory:');
    active = sqlite;
    __setRetrospectiveRunnerForTests(makeRunner(sqlite));

    findAll.mockResolvedValue([buildDemand()]);
    generateChatCompletion.mockRejectedValue(new Error('provider indisponível'));

    const { id } = await retrospectiveService.start('2026-07-01', '2026-07-07');
    await vi.waitFor(async () => {
      const session = await retrospectiveService.findById(id);
      expect(session?.status).toBe('failed');
    });

    const session = await retrospectiveService.findById(id);
    expect(session?.errorMessage).toContain('provider indisponível');
  });

  it('Demanda 10135 — atualiza messages corretamente com array vazio, payload realista e trata sessão inexistente', async () => {
    const sqlite = new Database(':memory:');
    active = sqlite;
    __setRetrospectiveRunnerForTests(makeRunner(sqlite));

    const { id } = await retrospectiveService.start('2026-07-01', '2026-07-07');

    // Cenário: array vazio -> deve persistir []
    const updatedEmpty = await retrospectiveService.updateMessages(id, []);
    expect(updatedEmpty.messages).toEqual([]);

    // Cenário: payload realista (5+ mensagens) -> deve persistir e ser retornado no SELECT (regressão)
    const payloadRealista = Array.from({ length: 6 }, (_, i) => ({
      agent: `agent_${i}`,
      content: `Mensagem de teste ${i}`,
      createdAt: new Date().toISOString(),
    }));
    const updatedReal = await retrospectiveService.updateMessages(id, payloadRealista);
    expect(updatedReal.messages).toHaveLength(6);
    expect(updatedReal.messages[0].content).toBe('Mensagem de teste 0');

    // Regressão: SELECT subsequente deve retornar as mesmas 6 mensagens
    const fetched = await retrospectiveService.findById(id);
    expect(fetched?.messages).toEqual(payloadRealista);

    // Cenário: sessão inexistente -> deve lançar erro tratável (404/not found)
    await expect(retrospectiveService.updateMessages('id-inexistente-123', [])).rejects.toThrow(
      'Sessão de retrospectiva não encontrada',
    );
  });
});
