/**
 * MÉDIO-04 — snapshot mínimo retido quando uma demanda é apagada.
 *
 * O problema medido: `llm_audit_logs` guarda `demand_id` em 10.676 das 11.471
 * chamadas, mas 10.517 apontam para demandas que não existem mais. A atribuição
 * de custo não estava faltando — estava pendurada no vazio. O mesmo vale para
 * 175 de 180 `demand_generation_jobs` e 23 de 30 `orchestration_runs`.
 *
 * A causa é uma assimetria: `deleteDemand` apaga 13 tabelas filhas, mas não
 * `demand_generation_jobs`, `orchestration_runs`, `agent_turns`,
 * `agent_tool_calls` nem `feedback_refinamento` — que o `clearDemands` apaga.
 * E `llm_audit_logs` não é apagado em lugar nenhum, o que é desejável: é a
 * trilha de auditoria.
 *
 * A política escolhida é RETER: antes de apagar, grava-se um registro imutável
 * com o mínimo necessário para que as trilhas órfãs continuem correlacionáveis.
 * Sem isso, "quanto custou uma demanda útil?" fica sem resposta assim que a
 * demanda some.
 *
 * Segue o padrão `ensureSchema` de `agent-jobs.ts`/`code-agent-job-queue.ts`
 * (CREATE TABLE IF NOT EXISTS via dbHelper) em vez de migration Drizzle — a
 * feature é local-only e assim não mexe no gate pg-smoke.
 */
import { sql, type SQL } from 'drizzle-orm';

import { dbHelper, isPostgres } from '../db';
import { logger } from '../utils/logger';

export interface DemandArchiveDbRunner {
  run(query: SQL): Promise<void> | void;
  all<T = Record<string, unknown>>(query: SQL): Promise<T[]> | T[];
}

let runner: DemandArchiveDbRunner = dbHelper;

/** Injeta runner in-memory nos testes; null restaura o global. */
export function __setDemandArchiveRunnerForTests(custom: DemandArchiveDbRunner | null): void {
  runner = custom ?? dbHelper;
  demandArchiveService.resetSchemaCacheForTests();
}

export const DEMAND_ARCHIVE_CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS demand_archive (
    demand_id INTEGER PRIMARY KEY NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT '',
    final_status TEXT NOT NULL DEFAULT '',
    quality_gate_status TEXT,
    requires_human_review INTEGER NOT NULL DEFAULT 0,
    llm_calls INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    archived_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS demand_archive_archived_at_idx ON demand_archive(archived_at)`,
] as const;

export interface DemandArchiveInput {
  demandId: number;
  title?: string | null;
  type?: string | null;
  finalStatus?: string | null;
  qualityGateStatus?: string | null;
  requiresHumanReview?: boolean | null;
}

export interface DemandArchiveRecord {
  demandId: number;
  title: string;
  type: string;
  finalStatus: string;
  qualityGateStatus: string | null;
  requiresHumanReview: boolean;
  llmCalls: number;
  totalTokens: number;
  costUsd: number;
  archivedAt: number;
}

interface ArchiveRow {
  demand_id: number;
  title: string;
  type: string;
  final_status: string;
  quality_gate_status: string | null;
  requires_human_review: number;
  llm_calls: number;
  total_tokens: number;
  cost_usd: number;
  archived_at: number;
}

export class DemandArchiveService {
  private ensured = false;

  resetSchemaCacheForTests(): void {
    this.ensured = false;
  }

  async ensureSchema(): Promise<void> {
    if (this.ensured || isPostgres) return;
    for (const statement of DEMAND_ARCHIVE_CREATE_STATEMENTS) {
      await runner.run(sql.raw(statement));
    }
    this.ensured = true;
  }

  /**
   * Congela o custo acumulado da demanda no momento do arquivamento.
   *
   * Lê de `llm_audit_logs` porque é a trilha que sobrevive ao delete — depois
   * que a demanda some, esta é a única fonte do custo dela.
   */
  private async summarizeCost(
    demandId: number,
  ): Promise<{ calls: number; tokens: number; costUsd: number }> {
    try {
      const rows = await runner.all<{ calls: number; tokens: number; cost: number }>(
        sql`SELECT COUNT(*) AS calls,
                   COALESCE(SUM(total_tokens), 0) AS tokens,
                   COALESCE(SUM(estimated_cost_usd), 0) AS cost
            FROM llm_audit_logs WHERE demand_id = ${demandId}`,
      );
      const row = rows[0];
      return {
        calls: Number(row?.calls ?? 0),
        tokens: Number(row?.tokens ?? 0),
        costUsd: Number(row?.cost ?? 0),
      };
    } catch (error) {
      // Trilha ausente não pode impedir o arquivamento: perder o snapshot
      // inteiro por causa do custo seria pior que registrá-lo com zero.
      logger.warn('demand-archive: falha ao somar custo da demanda', {
        error: error instanceof Error ? error : undefined,
        context: { demandId },
      });
      return { calls: 0, tokens: 0, costUsd: 0 };
    }
  }

  /**
   * Grava o snapshot. Idempotente por `demand_id`. NUNCA lança: falhar aqui não
   * pode impedir o usuário de apagar uma demanda.
   */
  async archive(input: DemandArchiveInput): Promise<void> {
    if (isPostgres) return;
    try {
      await this.ensureSchema();
      const cost = await this.summarizeCost(input.demandId);
      await runner.run(
        sql`INSERT INTO demand_archive
              (demand_id, title, type, final_status, quality_gate_status,
               requires_human_review, llm_calls, total_tokens, cost_usd)
            VALUES (${input.demandId}, ${input.title ?? ''}, ${input.type ?? ''},
                    ${input.finalStatus ?? ''}, ${input.qualityGateStatus ?? null},
                    ${input.requiresHumanReview ? 1 : 0}, ${cost.calls},
                    ${cost.tokens}, ${cost.costUsd})
            ON CONFLICT(demand_id) DO NOTHING`,
      );
    } catch (error) {
      logger.error('demand-archive: falha ao arquivar demanda', {
        error: error instanceof Error ? error : undefined,
        context: { demandId: input.demandId },
      });
    }
  }

  /** Snapshot de uma demanda apagada, para correlacionar trilhas órfãs. */
  async findById(demandId: number): Promise<DemandArchiveRecord | null> {
    if (isPostgres) return null;
    await this.ensureSchema();
    const rows = await runner.all<ArchiveRow>(
      sql`SELECT * FROM demand_archive WHERE demand_id = ${demandId}`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      demandId: row.demand_id,
      title: row.title,
      type: row.type,
      finalStatus: row.final_status,
      qualityGateStatus: row.quality_gate_status,
      requiresHumanReview: row.requires_human_review === 1,
      llmCalls: row.llm_calls,
      totalTokens: row.total_tokens,
      costUsd: row.cost_usd,
      archivedAt: row.archived_at,
    };
  }
}

export const demandArchiveService = new DemandArchiveService();
