/**
 * AgentInterventionService
 *
 * Persists the structured parecer (3 mandatory fields) produced by the
 * Anti-Overengineering Agent and exposes monthly savings metrics for the
 * /metricas-anti chat command.
 */

import { dbHelper } from '../db';
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger';

// ─── Domain types ───────────────────────────────────────────────────────────

export interface AgentInterventionEntry {
  id: number;
  demandId: number;
  pontosOverengineering: string[];
  escopoReduzido: string;
  roiEstimado: string;
  esforcoOriginalDias: number | null;
  esforcoReduzidoDias: number | null;
  diasEconomizados: number | null; // computed by DB
  overrideApplied: boolean;
  overrideBy: string | null;
  overrideJustification: string | null;
  modelo: string | null;
  criadoEm: Date;
}

export interface CreateAgentInterventionInput {
  demandId: number;
  pontosOverengineering: string[];
  escopoReduzido: string;
  roiEstimado: string;
  esforcoOriginalDias?: number | null;
  esforcoReduzidoDias?: number | null;
  modelo?: string | null;
}

export interface AntiMetricsSummary {
  totalInterventions: number;
  totalDiasEconomizados: number;
  overridesCount: number;
  interventionsByMonth: Array<{
    month: string; // YYYY-MM
    interventions: number;
    diasEconomizados: number;
  }>;
}

// ─── Raw DB row type ─────────────────────────────────────────────────────────

interface RawRow {
  id: number;
  demand_id: number;
  pontos_overengineering: string | null;
  escopo_reduzido: string;
  roi_estimado: string;
  esforco_original_dias: number | null;
  esforco_reduzido_dias: number | null;
  dias_economizados: number | null;
  override_applied: number | boolean;
  override_by: string | null;
  override_justification: string | null;
  modelo: string | null;
  criado_em: number;
}

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * `dias_economizados` é DERIVADO, nunca inserido: é a diferença entre o esforço
 * antes e depois da intervenção. Calculamos na consulta em vez de depender de
 * uma coluna gerada no banco.
 *
 * Por quê: a tabela tinha três definições divergentes — `shared/schema.ts`
 * (fonte da verdade do Drizzle, SEM a coluna), `migrations/0017` e o
 * `CREATE TABLE` deste serviço (ambos COM ela, como `GENERATED ALWAYS AS
 * ... STORED`). Como o Drizzle cria a tabela primeiro, o `CREATE TABLE IF NOT
 * EXISTS` daqui vira no-op e a coluna nunca existe — daí o "no such column".
 *
 * Adicionar a coluna via ALTER TABLE não resolveria de forma durável: o
 * `db:push` reconcilia o banco com `schema.ts` e a removeria de novo. E o
 * SQLite nem permite ADD COLUMN de coluna gerada STORED.
 *
 * Calcular na consulta elimina a divergência, dispensa migration e vale
 * igualmente para SQLite e Postgres.
 */
const DIAS_ECONOMIZADOS_EXPR = sql`
  CASE
    WHEN esforco_original_dias IS NOT NULL AND esforco_reduzido_dias IS NOT NULL
    THEN esforco_original_dias - esforco_reduzido_dias
    ELSE NULL
  END
`;

class AgentInterventionService {
  private tableReady = false;

  async ensureTable(): Promise<void> {
    if (this.tableReady) return;
    try {
      await dbHelper.run(sql`
        CREATE TABLE IF NOT EXISTS agent_interventions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          demand_id INTEGER NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
          pontos_overengineering TEXT NOT NULL,
          escopo_reduzido TEXT NOT NULL,
          roi_estimado TEXT NOT NULL,
          esforco_original_dias REAL,
          esforco_reduzido_dias REAL,
          -- Sem dias_economizados: o valor é derivado na consulta
          -- (DIAS_ECONOMIZADOS_EXPR). Este CREATE TABLE precisa espelhar
          -- shared/schema.ts, senão bancos criados por aqui e pelo Drizzle
          -- ficam com formatos diferentes — a causa original do bug.
          override_applied INTEGER NOT NULL DEFAULT 0,
          override_by TEXT,
          override_justification TEXT,
          modelo TEXT,
          criado_em INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
      await dbHelper.run(sql`
        CREATE INDEX IF NOT EXISTS idx_agent_interventions_demand_id ON agent_interventions(demand_id)
      `);
      await dbHelper.run(sql`
        CREATE INDEX IF NOT EXISTS idx_agent_interventions_criado_em ON agent_interventions(criado_em)
      `);
      this.tableReady = true;
    } catch (error) {
      logger.warn('Could not create agent_interventions table', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  private mapRow(r: RawRow): AgentInterventionEntry {
    let pontos: string[] = [];
    try {
      pontos = r.pontos_overengineering ? JSON.parse(r.pontos_overengineering) : [];
    } catch (_) {
      pontos = r.pontos_overengineering ? [r.pontos_overengineering] : [];
    }
    return {
      id: r.id,
      demandId: r.demand_id,
      pontosOverengineering: pontos,
      escopoReduzido: r.escopo_reduzido,
      roiEstimado: r.roi_estimado,
      esforcoOriginalDias: r.esforco_original_dias ?? null,
      esforcoReduzidoDias: r.esforco_reduzido_dias ?? null,
      diasEconomizados: r.dias_economizados ?? null,
      overrideApplied: Boolean(r.override_applied),
      overrideBy: r.override_by ?? null,
      overrideJustification: r.override_justification ?? null,
      modelo: r.modelo ?? null,
      criadoEm: new Date(r.criado_em * 1000),
    };
  }

  async create(input: CreateAgentInterventionInput): Promise<AgentInterventionEntry> {
    await this.ensureTable();

    const now = Math.floor(Date.now() / 1000);
    const pontosJson = JSON.stringify(input.pontosOverengineering);
    const esforcoOriginal = input.esforcoOriginalDias ?? null;
    const esforcoReduzido = input.esforcoReduzidoDias ?? null;
    const modelo = input.modelo ?? null;

    try {
      const rows = await dbHelper.all<RawRow>(sql`
        INSERT INTO agent_interventions
          (demand_id, pontos_overengineering, escopo_reduzido, roi_estimado,
           esforco_original_dias, esforco_reduzido_dias, modelo, criado_em)
        VALUES
          (${input.demandId}, ${pontosJson}, ${input.escopoReduzido}, ${input.roiEstimado},
           ${esforcoOriginal}, ${esforcoReduzido}, ${modelo}, ${now})
        RETURNING *
      `);

      const row = rows[0];
      if (!row) throw new Error('Insert returned no row');
      return this.mapRow(row);
    } catch (err) {
      // SQLite RETURNING fallback
      if (err instanceof Error && err.message.includes('syntax')) {
        await dbHelper.run(sql`
          INSERT INTO agent_interventions
            (demand_id, pontos_overengineering, escopo_reduzido, roi_estimado,
             esforco_original_dias, esforco_reduzido_dias, modelo, criado_em)
          VALUES
            (${input.demandId}, ${pontosJson}, ${input.escopoReduzido}, ${input.roiEstimado},
             ${esforcoOriginal}, ${esforcoReduzido}, ${modelo}, ${now})
        `);
        const ids = await dbHelper.all<{ id: number }>(sql`SELECT last_insert_rowid() AS id`);
        const id = ids[0]?.id ?? 0;
        return {
          id,
          demandId: input.demandId,
          pontosOverengineering: input.pontosOverengineering,
          escopoReduzido: input.escopoReduzido,
          roiEstimado: input.roiEstimado,
          esforcoOriginalDias: esforcoOriginal,
          esforcoReduzidoDias: esforcoReduzido,
          diasEconomizados:
            esforcoOriginal !== null && esforcoReduzido !== null
              ? esforcoOriginal - esforcoReduzido
              : null,
          overrideApplied: false,
          overrideBy: null,
          overrideJustification: null,
          modelo,
          criadoEm: new Date(now * 1000),
        };
      }
      throw err;
    }
  }

  async getByDemandId(demandId: number): Promise<AgentInterventionEntry[]> {
    await this.ensureTable();
    // `SELECT *` não traz `dias_economizados` (coluna inexistente no banco), e
    // o `?? null` de `mapRow` engolia isso em silêncio: esta consulta vinha
    // devolvendo `diasEconomizados: null` desde sempre, sem erro visível.
    const rows = await dbHelper.all<RawRow>(sql`
      SELECT *, ${DIAS_ECONOMIZADOS_EXPR} AS dias_economizados
      FROM agent_interventions WHERE demand_id = ${demandId} ORDER BY criado_em DESC
    `);
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Apply an override to an existing intervention record.
   * Only roles in OVERRIDE_ROLES should call this (validated at route layer).
   */
  async applyOverride(
    interventionId: number,
    overrideBy: string,
    justification: string,
  ): Promise<void> {
    await this.ensureTable();
    await dbHelper.run(sql`
      UPDATE agent_interventions
      SET override_applied = 1,
          override_by = ${overrideBy},
          override_justification = ${justification}
      WHERE id = ${interventionId}
    `);
  }

  /**
   * Monthly metrics for /metricas-anti dashboard.
   * Returns aggregated data for the last N months (default 3).
   */
  async getMonthlyMetrics(lastMonths = 3): Promise<AntiMetricsSummary> {
    await this.ensureTable();

    const cutoffEpoch = Math.floor(
      new Date(new Date().getFullYear(), new Date().getMonth() - lastMonths + 1, 1).getTime() /
        1000,
    );

    const rows = await dbHelper.all<{
      id: number;
      dias_economizados: number | null;
      override_applied: number | boolean;
      criado_em: number;
    }>(sql`
      SELECT id, ${DIAS_ECONOMIZADOS_EXPR} AS dias_economizados, override_applied, criado_em
      FROM agent_interventions
      WHERE criado_em >= ${cutoffEpoch}
      ORDER BY criado_em ASC
    `);

    const byMonth: Record<string, { interventions: number; diasEconomizados: number }> = {};
    let totalDias = 0;
    let overrides = 0;

    for (const r of rows) {
      const d = new Date(r.criado_em * 1000);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!byMonth[key]) byMonth[key] = { interventions: 0, diasEconomizados: 0 };
      byMonth[key].interventions += 1;
      const saved = r.dias_economizados ?? 0;
      byMonth[key].diasEconomizados += saved;
      totalDias += saved;
      if (r.override_applied) overrides += 1;
    }

    return {
      totalInterventions: rows.length,
      totalDiasEconomizados: totalDias,
      overridesCount: overrides,
      interventionsByMonth: Object.entries(byMonth)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, v]) => ({ month, ...v })),
    };
  }
}

export const agentInterventionService = new AgentInterventionService();
