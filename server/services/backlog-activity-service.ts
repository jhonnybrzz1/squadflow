/**
 * Demanda 10096 — backlog com criação automática de atividades no handoff.
 *
 * Uma atividade é criada quando uma demanda conclui o refinamento (evento de
 * handoff), numa tabela **separada** de `demands` — decisão do consenso: o
 * backlog é uma projeção de trabalho, não uma coluna a mais na demanda.
 *
 * O status segue uma máquina de estados fechada; transições inválidas são
 * rejeitadas na origem, não "corrigidas" silenciosamente. Padrão durável do
 * projeto: SQL bruto via `dbHelper`, `ensureSchema()` idempotente, runner
 * injetável, guard `isPostgres`.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';

import { db, dbHelper, isPostgres } from '../db';
import { backlogActivities } from '@shared/schema-unified';

/**
 * Auditoria 2026-08-01 (A08 / demanda #10289): este serviço executava SQL
 * SQLite cru (`datetime('now')`, `rowid`, booleanos 0/1) mesmo no perfil
 * PostgreSQL — onde a tabela sequer existia, porque não havia migration PG e
 * `ensureSchema()` retorna cedo quando `isPostgres`. O resultado era uma
 * demanda concluir sem que a atividade de backlog fosse criada, em silêncio.
 *
 * As consultas passam a ser Drizzle tipado sobre `backlogActivities`, que
 * resolve o dialeto sozinho: BOOLEAN nativo no PG e 0/1 no SQLite, `now()` vs
 * `datetime('now')`. O seam de teste continua existindo, agora recebendo a
 * própria instância Drizzle — os testes seguem usando SQLite real em memória.
 */
type BacklogDb = typeof db;

let database: BacklogDb = db;

export function __setBacklogDbForTests(custom: BacklogDb | null): void {
  database = custom ?? db;
  backlogActivityService.resetSchemaCacheForTests();
}

/** Status do enum do consenso (10090/10096). */
export const BACKLOG_STATUSES = [
  'em_desenvolvimento',
  'aguardando_revisao',
  'pronto',
  'em_producao',
] as const;
export type BacklogStatus = (typeof BACKLOG_STATUSES)[number];

/**
 * Transições permitidas. Fechada de propósito: pular de `em_desenvolvimento`
 * direto para `em_producao` esconde a revisão, e voltar de `em_producao` não é
 * uma transição de backlog — é rollback, outro fluxo.
 */
const ALLOWED_TRANSITIONS: Record<BacklogStatus, BacklogStatus[]> = {
  em_desenvolvimento: ['aguardando_revisao'],
  aguardando_revisao: ['pronto', 'em_desenvolvimento'], // reprovou volta pro dev
  pronto: ['em_producao', 'aguardando_revisao'],
  em_producao: [],
};

export function isValidTransition(from: BacklogStatus, to: BacklogStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export const BACKLOG_ACTIVITY_CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS backlog_activities (
    id TEXT PRIMARY KEY NOT NULL,
    demand_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'em_desenvolvimento',
    has_prd INTEGER NOT NULL DEFAULT 0,
    has_tasks INTEGER NOT NULL DEFAULT 0,
    has_chat INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Um handoff por demanda: evita atividade duplicada se o evento reemitir.
  `CREATE UNIQUE INDEX IF NOT EXISTS backlog_activities_demand_idx
     ON backlog_activities(demand_id)`,
] as const;

/**
 * A08: normaliza `created_at`/`updated_at` gravados como epoch-string.
 *
 * A coluna é TEXT com default `datetime('now')`, mas a afinidade TEXT do SQLite
 * converte em string qualquer número gravado — então escritas que passaram um
 * timestamp numérico deixaram linhas em epoch no meio das ISO. Como
 * `ORDER BY created_at` compara lexicograficamente, essas linhas afundavam para
 * o fim da listagem independentemente da data real.
 *
 * Vive aqui, e não só em `migrations/0055`, porque nada no runtime aplica os
 * arquivos daquela pasta no SQLite — o schema vem justamente do `ensureSchema`.
 * O WHERE só casa dígitos puros, então é idempotente e não toca linhas já ISO.
 */
const BACKLOG_ACTIVITY_NORMALIZE_STATEMENTS = [
  `UPDATE backlog_activities
     SET created_at = datetime(CAST(created_at AS INTEGER), 'unixepoch')
   WHERE created_at GLOB '[0-9]*' AND created_at NOT GLOB '*[^0-9]*'`,
  `UPDATE backlog_activities
     SET updated_at = datetime(CAST(updated_at AS INTEGER), 'unixepoch')
   WHERE updated_at GLOB '[0-9]*' AND updated_at NOT GLOB '*[^0-9]*'`,
] as const;

export interface BacklogActivity {
  id: string;
  demandId: number;
  title: string;
  status: BacklogStatus;
  hasPrd: boolean;
  hasTasks: boolean;
  hasChat: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A08: SQLite guarda TEXT ISO, PostgreSQL guarda `timestamp` (que o driver
 * devolve como Date). A API expõe string ISO nos dois casos — normalizar aqui
 * evita que o formato do banco vaze para o cliente.
 */
function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? '');
}

/**
 * A08: `updated_at` é TEXT no SQLite e `timestamp` no PostgreSQL. O valor
 * gravado tem que casar com a coluna do dialeto ativo — era exatamente isso que
 * o `datetime('now')` cru quebrava no PG.
 */
function nowForDialect(): never {
  return (isPostgres ? new Date() : new Date().toISOString()) as never;
}

type ActivityRow = typeof backlogActivities.$inferSelect;

function toActivity(r: ActivityRow): BacklogActivity {
  return {
    id: r.id,
    demandId: r.demandId,
    title: r.title,
    status: r.status as BacklogStatus,
    hasPrd: Boolean(r.hasPrd),
    hasTasks: Boolean(r.hasTasks),
    hasChat: Boolean(r.hasChat),
    createdAt: toIsoString(r.createdAt),
    updatedAt: toIsoString(r.updatedAt),
  };
}

export class BacklogActivityService {
  private ensured = false;

  resetSchemaCacheForTests(): void {
    this.ensured = false;
  }

  /**
   * A08: no PostgreSQL a tabela agora vem da migration
   * `0055_backlog_and_prompt_versioning.sql` — antes não vinha de lugar nenhum.
   * O caminho de runtime segue apenas para SQLite (inclusive `:memory:` nos
   * testes), com o mesmo DDL da migration 0044.
   */
  async ensureSchema(): Promise<void> {
    if (this.ensured || isPostgres) return;
    const runner = database as unknown as { run(query: SQL): Promise<unknown> | unknown };
    for (const statement of BACKLOG_ACTIVITY_CREATE_STATEMENTS) {
      await runner.run(sql.raw(statement));
    }
    for (const statement of BACKLOG_ACTIVITY_NORMALIZE_STATEMENTS) {
      await runner.run(sql.raw(statement));
    }
    this.ensured = true;
  }

  /**
   * Criação automática no handoff. Idempotente por `demand_id` (ON CONFLICT
   * DO NOTHING): o evento reemitir não cria atividade duplicada.
   */
  async createFromHandoff(input: {
    demandId: number;
    title: string;
    hasPrd?: boolean;
    hasTasks?: boolean;
    hasChat?: boolean;
  }): Promise<void> {
    await this.ensureSchema();
    await database
      .insert(backlogActivities)
      .values({
        id: randomUUID(),
        demandId: input.demandId,
        title: input.title,
        hasPrd: input.hasPrd ?? false,
        hasTasks: input.hasTasks ?? false,
        hasChat: input.hasChat ?? false,
      })
      .onConflictDoNothing({ target: backlogActivities.demandId });
  }

  async list(): Promise<BacklogActivity[]> {
    await this.ensureSchema();
    // A08: o desempate era por `rowid`, coluna que não existe no PostgreSQL.
    // `id` é único nos dois dialetos e serve ao mesmo propósito: ordem estável
    // quando dois registros compartilham o mesmo timestamp.
    const rows = await database
      .select()
      .from(backlogActivities)
      .orderBy(desc(backlogActivities.createdAt), desc(backlogActivities.id));
    return rows.map(toActivity);
  }

  async findById(id: string): Promise<BacklogActivity | null> {
    await this.ensureSchema();
    const rows = await database
      .select()
      .from(backlogActivities)
      .where(eq(backlogActivities.id, id))
      .limit(1);
    return rows.length > 0 ? toActivity(rows[0]) : null;
  }

  async findByDemandId(demandId: number): Promise<BacklogActivity | null> {
    await this.ensureSchema();
    const rows = await database
      .select()
      .from(backlogActivities)
      .where(eq(backlogActivities.demandId, demandId))
      .limit(1);
    return rows.length > 0 ? toActivity(rows[0]) : null;
  }

  /**
   * Atualiza flags de artefatos (PRD/Tasks/Chat) quando eles forem gerados
   * posteriormente à criação da atividade. Safe: não cria registro, só atualiza
   * se existir.
   */
  async updateArtifactFlags(
    demandId: number,
    flags: { hasPrd?: boolean; hasTasks?: boolean; hasChat?: boolean },
  ): Promise<BacklogActivity | null> {
    await this.ensureSchema();
    const updates: Partial<typeof backlogActivities.$inferInsert> = {};
    if (flags.hasPrd !== undefined) updates.hasPrd = flags.hasPrd;
    if (flags.hasTasks !== undefined) updates.hasTasks = flags.hasTasks;
    if (flags.hasChat !== undefined) updates.hasChat = flags.hasChat;
    if (Object.keys(updates).length === 0) return this.findByDemandId(demandId);

    await database
      .update(backlogActivities)
      .set({ ...updates, updatedAt: nowForDialect() })
      .where(eq(backlogActivities.demandId, demandId));
    return this.findByDemandId(demandId);
  }

  /**
   * Transição MANUAL de status (via PATCH). Retorna a atividade atualizada, ou
   * `null` se a transição é inválida / a atividade não existe — o caller mapeia
   * para 404/422. Nunca "conserta" um pulo inválido em silêncio.
   */
  async transition(
    id: string,
    to: BacklogStatus,
  ): Promise<{ ok: true; activity: BacklogActivity } | { ok: false; reason: string }> {
    await this.ensureSchema();
    const current = await this.findById(id);
    if (!current) return { ok: false, reason: 'not_found' };
    if (!isValidTransition(current.status, to)) {
      return {
        ok: false,
        reason: `transição inválida: ${current.status} → ${to}`,
      };
    }
    await database
      .update(backlogActivities)
      .set({ status: to, updatedAt: nowForDialect() })
      .where(eq(backlogActivities.id, id));
    const updated = await this.findById(id);
    return updated ? { ok: true, activity: updated } : { ok: false, reason: 'not_found' };
  }
}

export const backlogActivityService = new BacklogActivityService();
