/**
 * Demanda 10078 — retrospectiva automatizada.
 *
 * O agente SM conduz a sessão: um pequeno subconjunto de agentes (tech_lead,
 * qa, product_owner) analisa as demandas e o "estado dos repositórios"
 * (agregado via `demands.repoFullName`, sem chamar GitHub) de um período
 * configurável, e o SM sintetiza um resumo + lista de insights. O resultado é
 * persistido e a sessão SEGUINTE lê a última sessão concluída como "memória
 * ativa" — sem tocar no pipeline principal de refinamento (AgentFactory).
 *
 * Segue o mesmo padrão append-only de `agent-jobs.ts`: SQLite via `dbHelper`,
 * `ensureSchema()` idempotente, guard `isPostgres` (feature local-only).
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { dbHelper, isPostgres } from '../db';
import { demandRepository } from '../repositories/demand-repository';
import { logger } from '../utils/logger';
import { openAIService } from './openai-ai';
import { AgentFactory } from './ai-squad/AgentFactory';
import type { Demand } from '@shared/schema';

/**
 * Subconjunto do `dbHelper` de que este serviço precisa. Injetável para os
 * testes rodarem contra um SQLite in-memory hermético sem tocar no db global.
 */
export interface RetrospectiveDbRunner {
  run(query: SQL): Promise<void> | void;
  all<T = Record<string, unknown>>(query: SQL): Promise<T[]> | T[];
}

let runner: RetrospectiveDbRunner = dbHelper;

/**
 * Injeta um runner alternativo (in-memory) nos testes; null restaura o global.
 * Também reseta o cache de `ensureSchema` do singleton — o novo db começa vazio.
 */
export function __setRetrospectiveRunnerForTests(custom: RetrospectiveDbRunner | null): void {
  runner = custom ?? dbHelper;
  retrospectiveService.resetSchemaCacheForTests();
}

/** Statements de criação — exportados para testes de schema contra `:memory:`. */
export const RETROSPECTIVE_SESSIONS_CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS retrospective_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    summary TEXT,
    insights TEXT NOT NULL DEFAULT '[]',
    demands_analyzed TEXT NOT NULL DEFAULT '[]',
    agent_participants TEXT NOT NULL DEFAULT '[]',
    messages TEXT NOT NULL DEFAULT '[]',
    error_message TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS retrospective_sessions_status_idx ON retrospective_sessions(status)`,
] as const;

export type RetrospectiveStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface RetrospectiveMessage {
  agent: string;
  content: string;
  createdAt: string;
}

export interface RetrospectiveSession {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: RetrospectiveStatus;
  summary: string | null;
  insights: string[];
  demandsAnalyzed: number[];
  agentParticipants: string[];
  messages: RetrospectiveMessage[];
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

interface RetrospectiveSessionRow {
  id: string;
  period_start: string;
  period_end: string;
  status: string;
  summary: string | null;
  insights: string;
  demands_analyzed: string;
  agent_participants: string;
  messages: string;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

/**
 * Serializa array para persistência em SQL bruto, isolando o dialeto.
 *
 * SQLite armazena JSON em colunas TEXT: usamos a string JSON.stringify direta.
 * Postgres com jsonb exige que o parâmetro seja interpretado como JSON;
 * enviar a string JSON pura como `text` falha em colunas jsonb, e enviar o
 * array nativo faz o driver `neon` serializá-lo como literal de array Postgres.
 * A solução é enviar a string JSON e aplicar `::jsonb` no placeholder.
 * A leitura é flexível em `parseJsonArray` (aceita string JSON ou array).
 */
export function serializeArray<T>(data: T[]): SQL {
  const serialized = JSON.stringify(data ?? []);
  if (isPostgres) {
    return sql`${serialized}::jsonb`;
  }
  return sql`${serialized}`;
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) {
    return raw as T[];
  }
  if (typeof raw === 'object' && raw !== null) {
    return [raw as T];
  }
  if (typeof raw !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (_) {
    // registro tolerante: um campo JSON corrompido não deve quebrar a leitura.
    return [];
  }
}

function toSession(row: RetrospectiveSessionRow): RetrospectiveSession {
  return {
    id: row.id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status as RetrospectiveStatus,
    summary: row.summary,
    insights: parseJsonArray<string>(row.insights),
    demandsAnalyzed: parseJsonArray<number>(row.demands_analyzed),
    agentParticipants: parseJsonArray<string>(row.agent_participants),
    messages: parseJsonArray<RetrospectiveMessage>(row.messages),
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

const SYNTHESIS_SCHEMA = z.object({
  summary: z.string(),
  insights: z.array(z.string()),
});

const DIGEST_CHAR_LIMIT = 8000;
const PARTICIPANT_AGENTS = ['tech_lead', 'qa', 'product_owner'] as const;

const DEFAULT_SM_SYSTEM_PROMPT =
  'Você é o Scrum Master conduzindo uma retrospectiva. Sintetize as análises recebidas de forma objetiva e acionável.';

interface RepoAggregate {
  repo: string;
  total: number;
  byStatus: Record<string, number>;
}

function buildDigest(demands: Demand[]): string {
  const byStatus: Record<string, number> = {};
  const byRepo = new Map<string, RepoAggregate>();
  const errors: string[] = [];
  const learnings: string[] = [];

  for (const d of demands) {
    byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;

    const repo = d.repoFullName ?? 'sem repositório vinculado';
    const agg = byRepo.get(repo) ?? { repo, total: 0, byStatus: {} };
    agg.total += 1;
    agg.byStatus[d.status] = (agg.byStatus[d.status] ?? 0) + 1;
    byRepo.set(repo, agg);

    if (d.status === 'error' && (d.errorMessage || d.validationNotes)) {
      errors.push(`#${d.id} ${d.title}: ${d.errorMessage ?? d.validationNotes}`);
    }
    for (const entry of (d.learningLog ?? []).slice(-2)) {
      learnings.push(`#${d.id}: ${entry}`);
    }
  }

  const statusLines =
    Object.entries(byStatus)
      .map(([status, count]) => `- ${status}: ${count}`)
      .join('\n') || '- nenhuma';

  const repoLines =
    [...byRepo.values()]
      .map(
        (r) =>
          `- ${r.repo}: ${r.total} demanda(s) (${Object.entries(r.byStatus)
            .map(([s, c]) => `${s}=${c}`)
            .join(', ')})`,
      )
      .join('\n') || '- nenhum repositório vinculado';

  const raw = `DEMANDAS DO PERÍODO: ${demands.length}

Por status:
${statusLines}

Por repositório:
${repoLines}

ERROS REGISTRADOS:
${errors.slice(0, 20).join('\n') || '- nenhum erro registrado'}

APRENDIZADOS JÁ REGISTRADOS (learning log das demandas):
${learnings.slice(0, 20).join('\n') || '- nenhum'}`;

  return raw.length > DIGEST_CHAR_LIMIT ? `${raw.slice(0, DIGEST_CHAR_LIMIT)}\n[...truncado]` : raw;
}

function buildPreviousBlock(previous: RetrospectiveSession | null): string {
  if (!previous) return 'Não há retrospectiva anterior registrada — esta é a primeira sessão.';
  return `RETROSPECTIVA ANTERIOR (${previous.periodStart} a ${previous.periodEnd}):
Resumo: ${previous.summary ?? '-'}
Insights: ${previous.insights.join('; ') || '-'}`;
}

function buildAnalysisPrompt(
  agentName: string,
  periodStart: string,
  periodEnd: string,
  digest: string,
  previous: RetrospectiveSession | null,
): string {
  return `Você está participando de uma sessão de RETROSPECTIVA conduzida pelo Scrum Master, cobrindo o período de ${periodStart} a ${periodEnd}.

${digest}

${buildPreviousBlock(previous)}

SUA TAREFA: como ${agentName}, escreva uma análise curta (3 a 5 bullets) apontando erros, riscos e oportunidades de melhoria observados no período, sob a sua perspectiva. Seja objetivo e acionável — nada de análise genérica.`;
}

function buildSynthesisPrompt(
  periodStart: string,
  periodEnd: string,
  digest: string,
  contributions: Array<{ agent: string; analysis: string }>,
  previous: RetrospectiveSession | null,
): string {
  const contributionsBlock =
    contributions.map((c) => `--- ${c.agent} ---\n${c.analysis}`).join('\n\n') ||
    '- nenhuma contribuição recebida';

  return `Você é o Scrum Master conduzindo e SINTETIZANDO a retrospectiva do período ${periodStart} a ${periodEnd}.

${digest}

ANÁLISES DOS AGENTES:
${contributionsBlock}

${buildPreviousBlock(previous)}

Sintetize um resumo objetivo ("summary") e uma lista de 3 a 6 aprendizados acionáveis ("insights") para as próximas sessões — construa sobre a retrospectiva anterior quando fizer sentido, sem repetir insights já registrados. Responda em JSON: {"summary": string, "insights": string[]}.`;
}

export class RetrospectiveService {
  private ensured = false;

  /** Testes: força re-execução de `ensureSchema` ao trocar o db injetado. */
  resetSchemaCacheForTests(): void {
    this.ensured = false;
  }

  async ensureSchema(): Promise<void> {
    if (this.ensured || isPostgres) return;
    for (const statement of RETROSPECTIVE_SESSIONS_CREATE_STATEMENTS) {
      await runner.run(sql.raw(statement));
    }
    // Migração de schema defensiva: para bancos SQLite que já possuíam a tabela `retrospective_sessions`
    // antes da inclusão da coluna `messages`
    try {
      await runner.run(
        sql.raw(
          "ALTER TABLE retrospective_sessions ADD COLUMN messages TEXT NOT NULL DEFAULT '[]'",
        ),
      );
    } catch (_) {
      // Ignora erro de coluna já existente
    }
    this.ensured = true;
  }

  /**
   * Cria a sessão em `running` e dispara a orquestração em background
   * (fire-and-forget — o caller não espera o ciclo completo de chamadas LLM).
   * Qualquer falha durante `run` marca a sessão como `failed`.
   */
  async start(periodStart: string, periodEnd: string): Promise<{ id: string }> {
    await this.ensureSchema();
    const id = randomUUID();
    await runner.run(
      sql`INSERT INTO retrospective_sessions (id, period_start, period_end, status)
          VALUES (${id}, ${periodStart}, ${periodEnd}, 'running')`,
    );

    this.run(id, periodStart, periodEnd).catch((error) => {
      logger.error('Retrospectiva falhou', {
        error: error instanceof Error ? error : undefined,
        context: { id },
      });
      this.markFailed(id, error instanceof Error ? error.message : 'Erro desconhecido').catch(
        () => {
          // Se nem o markFailed for possível, a sessão fica 'running' — visível
          // como travada na listagem; melhor do que lançar um unhandled rejection.
        },
      );
    });

    return { id };
  }

  async markCompleted(
    id: string,
    completion: {
      summary: string;
      insights: string[];
      demandsAnalyzed: number[];
      agentParticipants: string[];
    },
  ): Promise<void> {
    await this.ensureSchema();
    await runner.run(
      sql`UPDATE retrospective_sessions
          SET status = 'completed',
              summary = ${completion.summary},
              insights = ${serializeArray(completion.insights)},
              demands_analyzed = ${serializeArray(completion.demandsAnalyzed)},
              agent_participants = ${serializeArray(completion.agentParticipants)},
              completed_at = datetime('now')
          WHERE id = ${id}`,
    );
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    await this.ensureSchema();
    await runner.run(
      sql`UPDATE retrospective_sessions
          SET status = 'failed',
              error_message = ${errorMessage.slice(0, 1000)},
              completed_at = datetime('now')
          WHERE id = ${id}`,
    );
  }

  async pause(id: string): Promise<void> {
    await this.ensureSchema();
    await runner.run(
      sql`UPDATE retrospective_sessions
          SET status = 'paused'
          WHERE id = ${id} AND status = 'running'`,
    );
  }

  async resume(id: string): Promise<void> {
    await this.ensureSchema();
    await runner.run(
      sql`UPDATE retrospective_sessions
          SET status = 'running'
          WHERE id = ${id} AND status = 'paused'`,
    );
  }

  async cancel(id: string): Promise<void> {
    await this.ensureSchema();
    await runner.run(
      sql`UPDATE retrospective_sessions
          SET status = 'cancelled',
              completed_at = datetime('now')
          WHERE id = ${id} AND (status = 'running' OR status = 'paused')`,
    );
  }

  /**
   * Atualiza explicitamente o conjunto de mensagens da sessão.
   * Lança exceção/retorna false se a sessão não existir.
   */
  async updateMessages(
    id: string,
    messages: RetrospectiveMessage[],
  ): Promise<RetrospectiveSession> {
    await this.ensureSchema();
    const session = await this.findById(id);
    if (!session) {
      throw new Error('Sessão de retrospectiva não encontrada');
    }
    const serialized = serializeArray(messages);
    await runner.run(
      sql`UPDATE retrospective_sessions
          SET messages = ${serialized}
          WHERE id = ${id}`,
    );
    const updated = await this.findById(id);
    if (!updated) {
      throw new Error('Sessão de retrospectiva não encontrada');
    }
    return updated;
  }

  async appendMessages(id: string, messages: RetrospectiveMessage[]): Promise<void> {
    await this.ensureSchema();
    const session = await this.findById(id);
    if (!session) return;
    const updated = [...session.messages, ...messages];
    const serialized = serializeArray(updated);
    await runner.run(
      sql`UPDATE retrospective_sessions
          SET messages = ${serialized}
          WHERE id = ${id}`,
    );
  }

  async findById(id: string): Promise<RetrospectiveSession | null> {
    await this.ensureSchema();
    const rows = await runner.all<RetrospectiveSessionRow>(
      sql`SELECT * FROM retrospective_sessions WHERE id = ${id}`,
    );
    return rows.length > 0 ? toSession(rows[0]) : null;
  }

  /** Sessão concluída mais recente — a "memória ativa" lida pela próxima sessão. */
  async findLatestCompleted(): Promise<RetrospectiveSession | null> {
    await this.ensureSchema();
    const rows = await runner.all<RetrospectiveSessionRow>(
      sql`SELECT * FROM retrospective_sessions WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1`,
    );
    return rows.length > 0 ? toSession(rows[0]) : null;
  }

  async listAll(): Promise<RetrospectiveSession[]> {
    await this.ensureSchema();
    const rows = await runner.all<RetrospectiveSessionRow>(
      sql`SELECT * FROM retrospective_sessions ORDER BY created_at DESC LIMIT 50`,
    );
    return rows.map(toSession);
  }

  /**
   * Orquestra a sessão: agrega demandas/repos do período (sem chamar GitHub),
   * chama os agentes participantes sequencialmente e o SM sintetiza o
   * resultado, lendo a última sessão concluída como memória ativa.
   */
  async run(id: string, periodStart: string, periodEnd: string): Promise<void> {
    const periodStartMs = new Date(periodStart).getTime();
    const periodEndMs = new Date(`${periodEnd}T23:59:59.999Z`).getTime();

    const allDemands = await demandRepository.findAll();
    const demands = allDemands.filter((d) => {
      const createdMs = d.createdAt ? new Date(d.createdAt).getTime() : NaN;
      return Number.isFinite(createdMs) && createdMs >= periodStartMs && createdMs <= periodEndMs;
    });

    const digest = buildDigest(demands);
    const previous = await this.findLatestCompleted();

    const { agentConfigs } = new AgentFactory().loadConfigurations();
    const contributions: Array<{ agent: string; analysis: string }> = [];

    for (const agentName of PARTICIPANT_AGENTS) {
      const session = await this.findById(id);
      if (!session || session.status === 'cancelled') return;

      const config = agentConfigs[agentName];
      if (!config) continue;
      const analysis = await openAIService.generateChatCompletion(
        config.system_prompt,
        buildAnalysisPrompt(agentName, periodStart, periodEnd, digest, previous),
        {
          agentName,
          operation: 'retrospective:analysis',
          model: config.model,
          modelFallback: config.model_fallback,
          temperature: config.temperature,
          maxTokens: config.max_tokens,
          cache: false,
          failOpenOnError: true,
        },
      );
      contributions.push({ agent: agentName, analysis });
      await this.appendMessages(id, [
        { agent: agentName, content: analysis, createdAt: new Date().toISOString() },
      ]);
    }

    const session = await this.findById(id);
    if (!session || session.status === 'cancelled') return;

    const smConfig = agentConfigs['scrum_master'];
    const result = await openAIService.generateJSONResponse<{
      summary: string;
      insights: string[];
    }>(
      smConfig?.system_prompt ?? DEFAULT_SM_SYSTEM_PROMPT,
      buildSynthesisPrompt(periodStart, periodEnd, digest, contributions, previous),
      {
        agentName: 'scrum_master',
        operation: 'retrospective:synthesis',
        model: smConfig?.model,
        modelFallback: smConfig?.model_fallback,
        cache: false,
        failOpenOnError: true,
        // Auditoria 2026-08-03: sem `maxTokens`, `generateJSONResponse` caía no
        // default de `taskType: 'json'` — 400 tokens. Uma síntese de retrospectiva
        // é um resumo MAIS uma lista de insights sobre o período inteiro, com as
        // contribuições de todos os agentes no prompt; 400 tokens cortavam o JSON
        // no meio e o erro chegava ao usuário como "Unexpected end of JSON input".
        maxTokens: smConfig?.max_tokens ?? 2000,
        schema: SYNTHESIS_SCHEMA,
      },
    );

    await this.appendMessages(id, [
      {
        agent: 'scrum_master',
        content: `Resumo: ${result.summary}\nInsights: ${result.insights.join('\n- ')}`,
        createdAt: new Date().toISOString(),
      },
    ]);

    await this.markCompleted(id, {
      summary: result.summary,
      insights: result.insights,
      demandsAnalyzed: demands.map((d) => d.id),
      agentParticipants: [...contributions.map((c) => c.agent), 'scrum_master'],
    });
  }
}

export const retrospectiveService = new RetrospectiveService();
