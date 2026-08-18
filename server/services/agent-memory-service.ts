/**
 * Demanda 10088 (item 4) — memória de agente insert-only (`agent_memory`).
 *
 * Registra aprendizados/sessões de agentes (ex.: chat da retrospectiva do SM,
 * `memory_type='sm_session'`) para leitura paginada. Segue o mesmo padrão
 * durável de `agent-jobs.ts` / `retrospective-service.ts`: SQL bruto via
 * `dbHelper`, `ensureSchema()` idempotente, runner injetável para testes, guard
 * `isPostgres` (feature local-only).
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';

import { dbHelper, isPostgres } from '../db';
import { featureFlags } from './feature-flags';
import { logger } from '../utils/logger';

export interface AgentMemoryDbRunner {
  run(query: SQL): Promise<void> | void;
  all<T = Record<string, unknown>>(query: SQL): Promise<T[]> | T[];
}

let runner: AgentMemoryDbRunner = dbHelper;

export function __setAgentMemoryRunnerForTests(custom: AgentMemoryDbRunner | null): void {
  runner = custom ?? dbHelper;
  agentMemoryService.resetSchemaCacheForTests();
}

export const AGENT_MEMORY_CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS agent_memory (
    id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL,
    memory_type TEXT NOT NULL,
    content TEXT NOT NULL,
    source_demand_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Índice composto para a leitura mais recente por agente+tipo (created_at DESC).
  `CREATE INDEX IF NOT EXISTS agent_memory_lookup_idx
     ON agent_memory(agent_id, memory_type, created_at DESC)`,
] as const;

export interface AgentMemoryEntry {
  id: string;
  agentId: string;
  memoryType: string;
  content: string;
  sourceDemandId: number | null;
  createdAt: string;
}

interface AgentMemoryRow {
  id: string;
  agent_id: string;
  memory_type: string;
  content: string;
  source_demand_id: number | null;
  created_at: string;
}

function toEntry(r: AgentMemoryRow): AgentMemoryEntry {
  return {
    id: r.id,
    agentId: r.agent_id,
    memoryType: r.memory_type,
    content: r.content,
    sourceDemandId: r.source_demand_id ?? null,
    createdAt: r.created_at,
  };
}

export interface ListAgentMemoryParams {
  limit?: number;
  offset?: number;
  memoryType?: string;
  sourceDemandId?: number;
}

export class AgentMemoryService {
  private ensured = false;

  resetSchemaCacheForTests(): void {
    this.ensured = false;
  }

  async ensureSchema(): Promise<void> {
    if (this.ensured || isPostgres) return;
    for (const statement of AGENT_MEMORY_CREATE_STATEMENTS) {
      await runner.run(sql.raw(statement));
    }
    this.ensured = true;
  }

  /** Insert-only: registros de memória nunca são atualizados/removidos aqui. */
  async record(entry: {
    agentId: string;
    memoryType: string;
    content: string;
    sourceDemandId?: number | null;
  }): Promise<{ id: string }> {
    await this.ensureSchema();
    const id = randomUUID();
    await runner.run(
      sql`INSERT INTO agent_memory (id, agent_id, memory_type, content, source_demand_id)
          VALUES (${id}, ${entry.agentId}, ${entry.memoryType}, ${entry.content}, ${entry.sourceDemandId ?? null})`,
    );
    return { id };
  }

  /**
   * Spec 10126 T4: remove registros de agent_memory mais antigos que o TTL
   * configurado (feature flag `agentMemoryTtlDays`). Retorna a contagem de
   * registros removidos. Política de retenção: hard-delete após o período
   * configurado; o TTL 0 desabilita a limpeza.
   */
  async cleanup(ttlDays?: number): Promise<{ deleted: number }> {
    await this.ensureSchema();
    const effectiveTtlDays = ttlDays ?? featureFlags.getFlags().agentMemoryTtlDays;

    // TTL 0 desabilita a limpeza silenciosamente (política legada/Spec 10126 T4).
    if (effectiveTtlDays === 0) {
      return { deleted: 0 };
    }

    if (!Number.isInteger(effectiveTtlDays) || effectiveTtlDays < 0) {
      logger.warn('agent_memory cleanup skipped: invalid TTL', {
        context: { ttlDays: effectiveTtlDays },
      });
      return { deleted: 0 };
    }

    // security: use bound parameters instead of sql.raw interpolation.
    const cutoff = isPostgres
      ? sql`NOW() - INTERVAL '1 day' * ${effectiveTtlDays}`
      : sql`datetime('now', '-' || ${effectiveTtlDays} || ' days')`;

    const result = await runner.run(sql`DELETE FROM agent_memory WHERE created_at < ${cutoff}`);

    // sqlite/raw runners don't always return changes; count before/after when needed.
    const deleted =
      typeof result === 'object' && result !== null && 'changes' in result
        ? Number((result as { changes: number }).changes)
        : 0;

    logger.info('agent_memory cleanup completed', {
      context: { ttlDays: effectiveTtlDays, deleted },
    });

    return { deleted };
  }

  /** Lista paginada (default limit=50, offset=0) com filtros opcionais. */
  async list(params: ListAgentMemoryParams = {}): Promise<AgentMemoryEntry[]> {
    await this.ensureSchema();
    const limit = Math.max(1, Math.min(200, params.limit ?? 50));
    const offset = Math.max(0, params.offset ?? 0);

    const filters: SQL[] = [];
    if (params.memoryType) filters.push(sql`memory_type = ${params.memoryType}`);
    if (typeof params.sourceDemandId === 'number') {
      filters.push(sql`source_demand_id = ${params.sourceDemandId}`);
    }
    const where = filters.length
      ? sql`WHERE ${filters.reduce((acc, f, i) => (i === 0 ? f : sql`${acc} AND ${f}`))}`
      : sql``;

    // rowid DESC como desempate: created_at tem resolução de 1s, então dois
    // registros no mesmo segundo mantêm ordem de inserção determinística.
    const rows = await runner.all<AgentMemoryRow>(
      sql`SELECT * FROM agent_memory ${where} ORDER BY created_at DESC, rowid DESC LIMIT ${limit} OFFSET ${offset}`,
    );
    return rows.map(toEntry);
  }
}

export const agentMemoryService = new AgentMemoryService();
