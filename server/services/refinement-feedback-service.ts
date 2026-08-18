/**
 * Persists two independent feedback dimensions:
 * - satisfaction for an agent response (`nota`, legacy-compatible);
 * - operational status for an identifiable item in a versioned response.
 */

import { dbHelper, isPostgres } from '../db';
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger';
import type { RefinementItemFeedbackStatus } from '@shared/schema';

interface RefinementFeedbackRow {
  id: number;
  refinement_id: string;
  agent_id: string;
  nota: number | null;
  texto: string | null;
  modelo: string | null;
  qtd_iteracoes_ate_feedback: number | null;
  item_index: number | null;
  item_key: string | null;
  version_hash: string | null;
  status: RefinementItemFeedbackStatus | null;
  criado_em: number | string | Date;
  atualizado_em: number | string | Date;
}

export interface RefinementFeedbackEntry {
  id: number;
  refinementId: string;
  agentId: string;
  nota: number | null;
  texto: string | null;
  modelo: string | null;
  qtdIteracoesAteFeedback: number | null;
  itemIndex: number | null;
  itemKey: string | null;
  versionHash: string | null;
  status: RefinementItemFeedbackStatus | null;
  criadoEm: Date;
  atualizadoEm: Date;
}

export interface CreateRefinementFeedbackInput {
  refinementId: string;
  agentId: string;
  nota: number;
  texto?: string | null;
  modelo?: string | null;
  qtdIteracoesAteFeedback?: number | null;
}

export interface UpsertRefinementItemFeedbackInput {
  refinementId: string;
  agentId: string;
  itemIndex: number;
  itemKey: string;
  versionHash: string;
  status: RefinementItemFeedbackStatus;
  nota?: number | null;
  texto?: string | null;
  modelo?: string | null;
}

export interface UpsertRefinementItemFeedbackResult {
  entry: RefinementFeedbackEntry;
  created: boolean;
}

function databaseDate(value: number | string | Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') {
    return new Date(value < 10_000_000_000 ? value * 1000 : value);
  }
  return new Date(value);
}

function mapRow(row: RefinementFeedbackRow): RefinementFeedbackEntry {
  return {
    id: row.id,
    refinementId: row.refinement_id,
    agentId: row.agent_id,
    nota: row.nota ?? null,
    texto: row.texto ?? null,
    modelo: row.modelo ?? null,
    qtdIteracoesAteFeedback: row.qtd_iteracoes_ate_feedback ?? null,
    itemIndex: row.item_index ?? null,
    itemKey: row.item_key ?? null,
    versionHash: row.version_hash ?? null,
    status: row.status ?? null,
    criadoEm: databaseDate(row.criado_em),
    atualizadoEm: databaseDate(row.atualizado_em ?? row.criado_em),
  };
}

class RefinementFeedbackService {
  private tableReady = false;

  async ensureTable(): Promise<void> {
    if (this.tableReady) return;
    try {
      if (isPostgres) {
        await dbHelper.run(sql`
          CREATE TABLE IF NOT EXISTS feedback_refinamento (
            id SERIAL PRIMARY KEY,
            refinement_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            nota INTEGER CHECK (nota IS NULL OR (nota >= 1 AND nota <= 5)),
            texto TEXT,
            modelo TEXT,
            qtd_iteracoes_ate_feedback INTEGER,
            item_index INTEGER,
            item_key TEXT,
            version_hash TEXT,
            status TEXT CHECK (status IS NULL OR status IN ('feito', 'não_feito', 'desatualizado')),
            criado_em TIMESTAMP NOT NULL DEFAULT now(),
            atualizado_em TIMESTAMP NOT NULL DEFAULT now()
          )
        `);
      } else {
        await dbHelper.run(sql`
          CREATE TABLE IF NOT EXISTS feedback_refinamento (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            refinement_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            nota INTEGER CHECK (nota IS NULL OR (nota >= 1 AND nota <= 5)),
            texto TEXT,
            modelo TEXT,
            qtd_iteracoes_ate_feedback INTEGER,
            item_index INTEGER,
            item_key TEXT,
            version_hash TEXT,
            status TEXT CHECK (status IS NULL OR status IN ('feito', 'não_feito', 'desatualizado')),
            criado_em INTEGER NOT NULL DEFAULT (unixepoch()),
            atualizado_em INTEGER NOT NULL DEFAULT (unixepoch())
          )
        `);
      }
      await dbHelper.run(sql`
        CREATE INDEX IF NOT EXISTS idx_feedback_refinamento_agent_id
        ON feedback_refinamento(agent_id)
      `);
      await dbHelper.run(sql`
        CREATE INDEX IF NOT EXISTS idx_feedback_refinamento_refinement_id
        ON feedback_refinamento(refinement_id)
      `);
      await dbHelper.run(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_refinamento_item_version
        ON feedback_refinamento(refinement_id, version_hash, item_key)
      `);
      this.tableReady = true;
    } catch (error) {
      logger.warn('Could not create feedback_refinamento table', {
        error: error instanceof Error ? error : undefined,
      });
      throw error;
    }
  }

  async create(input: CreateRefinementFeedbackInput): Promise<RefinementFeedbackEntry> {
    await this.ensureTable();

    const now = isPostgres ? new Date() : Math.floor(Date.now() / 1000);
    const rows = await dbHelper.all<RefinementFeedbackRow>(sql`
      INSERT INTO feedback_refinamento (
        refinement_id, agent_id, nota, texto, modelo,
        qtd_iteracoes_ate_feedback, criado_em, atualizado_em
      )
      VALUES (
        ${input.refinementId}, ${input.agentId}, ${input.nota}, ${input.texto ?? null},
        ${input.modelo ?? null}, ${input.qtdIteracoesAteFeedback ?? null}, ${now}, ${now}
      )
      RETURNING *
    `);

    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return mapRow(row);
  }

  async upsertItemStatus(
    input: UpsertRefinementItemFeedbackInput,
  ): Promise<UpsertRefinementItemFeedbackResult> {
    await this.ensureTable();

    const previous = await dbHelper.get<{ id: number }>(sql`
      SELECT id FROM feedback_refinamento
      WHERE refinement_id = ${input.refinementId}
        AND version_hash = ${input.versionHash}
        AND item_key = ${input.itemKey}
      LIMIT 1
    `);
    const now = isPostgres ? new Date() : Math.floor(Date.now() / 1000);
    const rows = await dbHelper.all<RefinementFeedbackRow>(sql`
      INSERT INTO feedback_refinamento (
        refinement_id, agent_id, nota, texto, modelo, item_index, item_key,
        version_hash, status, criado_em, atualizado_em
      )
      VALUES (
        ${input.refinementId}, ${input.agentId}, ${input.nota ?? null}, ${input.texto ?? null},
        ${input.modelo ?? null}, ${input.itemIndex}, ${input.itemKey}, ${input.versionHash},
        ${input.status}, ${now}, ${now}
      )
      ON CONFLICT(refinement_id, version_hash, item_key) DO UPDATE SET
        agent_id = excluded.agent_id,
        item_index = excluded.item_index,
        status = excluded.status,
        nota = COALESCE(excluded.nota, feedback_refinamento.nota),
        texto = COALESCE(excluded.texto, feedback_refinamento.texto),
        modelo = COALESCE(excluded.modelo, feedback_refinamento.modelo),
        atualizado_em = excluded.atualizado_em
      RETURNING *
    `);

    const row = rows[0];
    if (!row) throw new Error('Upsert returned no row');
    return { entry: mapRow(row), created: !previous };
  }

  async getByRefinementVersion(
    refinementId: string,
    versionHash: string,
  ): Promise<RefinementFeedbackEntry[]> {
    await this.ensureTable();
    const rows = await dbHelper.all<RefinementFeedbackRow>(sql`
      SELECT * FROM feedback_refinamento
      WHERE refinement_id = ${refinementId}
        AND version_hash = ${versionHash}
        AND item_key IS NOT NULL
      ORDER BY item_index ASC, id ASC
    `);
    return rows.map(mapRow);
  }

  async getByAgentId(agentId: string): Promise<RefinementFeedbackEntry[]> {
    await this.ensureTable();
    const rows = await dbHelper.all<RefinementFeedbackRow>(sql`
      SELECT * FROM feedback_refinamento WHERE agent_id = ${agentId} ORDER BY criado_em DESC
    `);
    return rows.map(mapRow);
  }
}

export const refinementFeedbackService = new RefinementFeedbackService();
