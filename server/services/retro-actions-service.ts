/**
 * Demanda 10092 — retrospectiva com evidência de execução e ciclo de ações.
 *
 * Complementa a 10078 (que gera o texto da retro) com o lado **mensurável**:
 *   • `retrospectives`  — snapshot JSON das métricas do período (evidência).
 *   • `retro_actions`   — ações com métrica ANTES capturada do snapshot e
 *                          métrica DEPOIS preenchida na revisão seguinte.
 *
 * Duas decisões que valem registro:
 *  1. `diff_percent` e `success_met` são **computados na leitura**, nunca
 *     gravados — dado derivado em coluna vira mentira assim que a fórmula muda.
 *  2. Divisão por zero/NULL devolve `null`, não erro: a primeira retro não tem
 *     baseline e isso é normal, não falha.
 *
 * Tabelas novas, sem tocar em `retrospective_sessions` (backwards-compatible).
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';

import { dbHelper, isPostgres } from '../db';

export interface RetroDbRunner {
  run(query: SQL): Promise<void> | void;
  all<T = Record<string, unknown>>(query: SQL): Promise<T[]> | T[];
}

let runner: RetroDbRunner = dbHelper;

export function __setRetroActionsRunnerForTests(custom: RetroDbRunner | null): void {
  runner = custom ?? dbHelper;
  retroActionsService.resetSchemaCacheForTests();
}

export const RETRO_ACTIONS_CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS retrospectives (
    id TEXT PRIMARY KEY NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS retro_actions (
    id TEXT PRIMARY KEY NOT NULL,
    retro_id TEXT NOT NULL,
    description TEXT NOT NULL,
    owner TEXT,
    metric_key TEXT NOT NULL,
    metric_before REAL,
    metric_after REAL,
    success_criteria TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS retro_actions_retro_idx ON retro_actions(retro_id, created_at DESC)`,
] as const;

/** Métricas que uma ação pode mirar, com o limiar padrão de sucesso (queda %). */
export const DEFAULT_THRESHOLDS: Record<string, number> = {
  tokens: 20,
  cost: 15,
  latency: 10,
};

export interface RetroSnapshot {
  periodStart: string;
  periodEnd: string;
  demands: number;
  completed: number;
  failed: number;
  tokens: number;
  cost: number;
}

export interface RetroAction {
  id: string;
  retroId: string;
  description: string;
  owner: string | null;
  metricKey: string;
  metricBefore: number | null;
  metricAfter: number | null;
  successCriteria: string | null;
  /** Computado na leitura: null quando não há baseline utilizável. */
  diffPercent: number | null;
  /** Computado na leitura a partir do threshold ou do critério livre. */
  successMet: boolean | null;
  createdAt: string;
}

interface ActionRow {
  id: string;
  retro_id: string;
  description: string;
  owner: string | null;
  metric_key: string;
  metric_before: number | null;
  metric_after: number | null;
  success_criteria: string | null;
  created_at: string;
}

/**
 * Diff percentual protegido: sem baseline (NULL) ou baseline zero, não existe
 * variação percentual definida — devolve `null` em vez de Infinity/NaN.
 */
export function computeDiffPercent(before: number | null, after: number | null): number | null {
  if (before === null || before === 0 || after === null) return null;
  return ((after - before) / before) * 100;
}

/**
 * Sucesso = queda igual ou maior que o limiar da métrica. Com `successCriteria`
 * livre preenchido, a decisão é humana (não inventamos interpretação de texto)
 * e devolvemos `null` — "a avaliar", não "falhou".
 */
export function computeSuccessMet(
  metricKey: string,
  diffPercent: number | null,
  successCriteria: string | null,
): boolean | null {
  if (diffPercent === null) return null;
  if (successCriteria && successCriteria.trim()) return null;
  const threshold = DEFAULT_THRESHOLDS[metricKey];
  if (threshold === undefined) return null;
  return diffPercent <= -threshold;
}

export class RetroActionsService {
  private ensured = false;

  resetSchemaCacheForTests(): void {
    this.ensured = false;
  }

  async ensureSchema(): Promise<void> {
    if (this.ensured || isPostgres) return;
    for (const statement of RETRO_ACTIONS_CREATE_STATEMENTS) {
      await runner.run(sql.raw(statement));
    }
    this.ensured = true;
  }

  /** Cria a retro com o snapshot de evidência do período. */
  async createRetrospective(snapshot: RetroSnapshot): Promise<{ id: string }> {
    await this.ensureSchema();
    const id = randomUUID();
    await runner.run(
      sql`INSERT INTO retrospectives (id, period_start, period_end, snapshot)
          VALUES (${id}, ${snapshot.periodStart}, ${snapshot.periodEnd}, ${JSON.stringify(snapshot)})`,
    );
    return { id };
  }

  async findRetrospective(
    id: string,
  ): Promise<{ id: string; snapshot: RetroSnapshot; createdAt: string } | null> {
    await this.ensureSchema();
    const rows = await runner.all<{ id: string; snapshot: string; created_at: string }>(
      sql`SELECT id, snapshot, created_at FROM retrospectives WHERE id = ${id}`,
    );
    if (rows.length === 0) return null;
    let snapshot: RetroSnapshot;
    try {
      snapshot = JSON.parse(rows[0].snapshot) as RetroSnapshot;
    } catch (_) {
      return null;
    }
    return { id: rows[0].id, snapshot, createdAt: rows[0].created_at };
  }

  /**
   * Cria a ação capturando `metric_before` **do snapshot**, não de input manual
   * — baseline digitado à mão é onde a medição começa a mentir.
   */
  async createAction(
    retroId: string,
    input: {
      description: string;
      metricKey: string;
      owner?: string | null;
      successCriteria?: string | null;
    },
  ): Promise<RetroAction | null> {
    await this.ensureSchema();
    const retro = await this.findRetrospective(retroId);
    if (!retro) return null;

    const before = (retro.snapshot as unknown as Record<string, unknown>)[input.metricKey];
    const metricBefore = typeof before === 'number' ? before : null;

    const id = randomUUID();
    const now = new Date().toISOString();
    await runner.run(
      sql`INSERT INTO retro_actions
            (id, retro_id, description, owner, metric_key, metric_before, success_criteria, created_at)
          VALUES (${id}, ${retroId}, ${input.description}, ${input.owner ?? null},
                  ${input.metricKey}, ${metricBefore}, ${input.successCriteria ?? null}, ${now})`,
    );
    return {
      id,
      retroId,
      description: input.description,
      owner: input.owner ?? null,
      metricKey: input.metricKey,
      metricBefore,
      metricAfter: null,
      successCriteria: input.successCriteria ?? null,
      diffPercent: null,
      successMet: null,
      createdAt: now,
    };
  }

  /** Preenche a métrica DEPOIS (revisão da ação na retro seguinte). */
  async setMetricAfter(
    retroId: string,
    actionId: string,
    metricAfter: number,
  ): Promise<RetroAction | null> {
    await this.ensureSchema();
    const rows = await runner.all<ActionRow>(
      sql`SELECT * FROM retro_actions WHERE id = ${actionId} AND retro_id = ${retroId}`,
    );
    if (rows.length === 0) return null;

    await runner.run(
      sql`UPDATE retro_actions SET metric_after = ${metricAfter} WHERE id = ${actionId}`,
    );

    const updated = rows[0];
    updated.metric_after = metricAfter;
    const diffPercent = computeDiffPercent(updated.metric_before, updated.metric_after);
    return {
      id: updated.id,
      retroId: updated.retro_id,
      description: updated.description,
      owner: updated.owner ?? null,
      metricKey: updated.metric_key,
      metricBefore: updated.metric_before ?? null,
      metricAfter: updated.metric_after ?? null,
      successCriteria: updated.success_criteria ?? null,
      diffPercent,
      successMet: computeSuccessMet(
        updated.metric_key,
        diffPercent,
        updated.success_criteria ?? null,
      ),
      createdAt: updated.created_at,
    };
  }

  /** Lista as ações com diff e sucesso computados na leitura. */
  async listActions(retroId: string): Promise<RetroAction[]> {
    await this.ensureSchema();
    const rows = await runner.all<ActionRow>(
      sql`SELECT * FROM retro_actions WHERE retro_id = ${retroId} ORDER BY created_at DESC, rowid DESC`,
    );
    return rows.map((r) => {
      const diffPercent = computeDiffPercent(r.metric_before, r.metric_after);
      return {
        id: r.id,
        retroId: r.retro_id,
        description: r.description,
        owner: r.owner ?? null,
        metricKey: r.metric_key,
        metricBefore: r.metric_before ?? null,
        metricAfter: r.metric_after ?? null,
        successCriteria: r.success_criteria ?? null,
        diffPercent,
        successMet: computeSuccessMet(r.metric_key, diffPercent, r.success_criteria ?? null),
        createdAt: r.created_at,
      };
    });
  }
}

export const retroActionsService = new RetroActionsService();
