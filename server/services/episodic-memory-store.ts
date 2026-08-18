/**
 * Demanda 10094 — memória episódica para self-improvement (experimento: skill de
 * debugging).
 *
 * O risco de uma memória que se auto-alimenta é injetar no prompt algo que nunca
 * deveria sair de um episódio (segredo, PII) ou um "padrão" aprendido de um caso
 * único. Por isso duas travas, nesta ordem:
 *
 *  1. **Sanitização na ESCRITA** — o conteúdo é mascarado antes de tocar o banco
 *     (reusa `maskPii` dos guardrails; não reinventa detecção).
 *  2. **Filtro na INJEÇÃO** — mesmo já sanitizado, nada entra em prompt sem
 *     `sanitized = true`, `confidence >= 0.7` e `source_type = 'episodic'`.
 *
 * A trava dupla é intencional: se um episódio for gravado por outro caminho no
 * futuro (import, migração, bug), o ponto de injeção ainda segura.
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';

import { dbHelper, isPostgres } from '../db';
import { maskPii } from './llm-guardrails';

export interface EpisodicDbRunner {
  run(query: SQL): Promise<void> | void;
  all<T = Record<string, unknown>>(query: SQL): Promise<T[]> | T[];
}

let runner: EpisodicDbRunner = dbHelper;

export function __setEpisodicRunnerForTests(custom: EpisodicDbRunner | null): void {
  runner = custom ?? dbHelper;
  episodicMemoryStore.resetSchemaCacheForTests();
}

/** Confiança mínima para um padrão ser injetado em prompt. */
export const MIN_CONFIDENCE_FOR_INJECTION = 0.7;

export const EPISODIC_MEMORY_CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS episodic_memory (
    id TEXT PRIMARY KEY NOT NULL,
    skill TEXT NOT NULL,
    content TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    sanitized INTEGER NOT NULL DEFAULT 0,
    source_type TEXT NOT NULL DEFAULT 'episodic',
    retry_count INTEGER,
    duration_ms INTEGER,
    memory_active INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS episodic_memory_skill_idx
     ON episodic_memory(skill, confidence DESC, created_at DESC)`,
] as const;

export interface EpisodeInput {
  skill: string;
  content: string;
  confidence?: number;
  retryCount?: number | null;
  durationMs?: number | null;
  /** Marca se o episódio rodou COM memória ativa (baseline usa false). */
  memoryActive?: boolean;
}

export interface Episode {
  id: string;
  skill: string;
  content: string;
  confidence: number;
  sanitized: boolean;
  sourceType: string;
  retryCount: number | null;
  durationMs: number | null;
  memoryActive: boolean;
  createdAt: string;
}

interface EpisodeRow {
  id: string;
  skill: string;
  content: string;
  confidence: number;
  sanitized: number;
  source_type: string;
  retry_count: number | null;
  duration_ms: number | null;
  memory_active: number;
  created_at: string;
}

function toEpisode(r: EpisodeRow): Episode {
  return {
    id: r.id,
    skill: r.skill,
    content: r.content,
    confidence: r.confidence,
    sanitized: r.sanitized === 1,
    sourceType: r.source_type,
    retryCount: r.retry_count ?? null,
    durationMs: r.duration_ms ?? null,
    memoryActive: r.memory_active === 1,
    createdAt: r.created_at,
  };
}

/**
 * Um episódio só pode virar few-shot se passar nas três condições do PRD.
 * Função pura e exportada de propósito: é a regra que o teste precisa travar.
 */
export function isPromotable(episode: {
  confidence: number;
  sanitized: boolean;
  sourceType: string;
}): boolean {
  return (
    episode.confidence >= MIN_CONFIDENCE_FOR_INJECTION &&
    episode.sanitized === true &&
    episode.sourceType === 'episodic'
  );
}

export class EpisodicMemoryStore {
  private ensured = false;

  resetSchemaCacheForTests(): void {
    this.ensured = false;
  }

  async ensureSchema(): Promise<void> {
    if (this.ensured || isPostgres) return;
    for (const statement of EPISODIC_MEMORY_CREATE_STATEMENTS) {
      await runner.run(sql.raw(statement));
    }
    this.ensured = true;
  }

  /**
   * Grava o episódio SEMPRE sanitizado. Não existe caminho para persistir
   * conteúdo cru: a máscara roda aqui, antes do INSERT.
   */
  async record(input: EpisodeInput): Promise<{ id: string; masked: boolean }> {
    await this.ensureSchema();
    const { maskedContent, masked } = maskPii(input.content);
    const id = randomUUID();
    await runner.run(
      sql`INSERT INTO episodic_memory
            (id, skill, content, confidence, sanitized, source_type,
             retry_count, duration_ms, memory_active)
          VALUES (${id}, ${input.skill}, ${maskedContent}, ${input.confidence ?? 0}, 1,
                  'episodic', ${input.retryCount ?? null}, ${input.durationMs ?? null},
                  ${input.memoryActive ? 1 : 0})`,
    );
    return { id, masked };
  }

  async listBySkill(skill: string, limit = 50): Promise<Episode[]> {
    await this.ensureSchema();
    const rows = await runner.all<EpisodeRow>(
      sql`SELECT * FROM episodic_memory WHERE skill = ${skill}
          ORDER BY created_at DESC, rowid DESC LIMIT ${Math.max(1, Math.min(200, limit))}`,
    );
    return rows.map(toEpisode);
  }

  /**
   * Ponto de INJEÇÃO — segunda trava. Filtra por confiança/sanitização/origem
   * em SQL **e** revalida em memória com `isPromotable`: se a query mudar um dia,
   * o filtro em código ainda impede vazamento para o prompt.
   */
  async getInjectablePatterns(skill: string, limit = 5): Promise<Episode[]> {
    await this.ensureSchema();
    const rows = await runner.all<EpisodeRow>(
      sql`SELECT * FROM episodic_memory
          WHERE skill = ${skill}
            AND sanitized = 1
            AND source_type = 'episodic'
            AND confidence >= ${MIN_CONFIDENCE_FOR_INJECTION}
          ORDER BY confidence DESC, created_at DESC
          LIMIT ${Math.max(1, Math.min(20, limit))}`,
    );
    return rows.map(toEpisode).filter(isPromotable);
  }

  /**
   * Comparação de retry entre episódios com e sem memória ativa — é o número
   * que o experimento promete (queda de 30%). Sem amostra dos dois lados,
   * devolve `null` em vez de inventar variação.
   */
  async retryComparison(skill: string): Promise<{
    baseline: { episodes: number; avgRetry: number | null };
    withMemory: { episodes: number; avgRetry: number | null };
    reductionPercent: number | null;
  }> {
    await this.ensureSchema();
    const rows = await runner.all<EpisodeRow>(
      sql`SELECT * FROM episodic_memory WHERE skill = ${skill} AND retry_count IS NOT NULL`,
    );
    const episodes = rows.map(toEpisode);

    const avg = (list: Episode[]): number | null =>
      list.length === 0
        ? null
        : list.reduce((acc, e) => acc + (e.retryCount ?? 0), 0) / list.length;

    const base = episodes.filter((e) => !e.memoryActive);
    const withMem = episodes.filter((e) => e.memoryActive);
    const baseAvg = avg(base);
    const memAvg = avg(withMem);

    const reductionPercent =
      baseAvg === null || memAvg === null || baseAvg === 0
        ? null
        : ((baseAvg - memAvg) / baseAvg) * 100;

    return {
      baseline: { episodes: base.length, avgRetry: baseAvg },
      withMemory: { episodes: withMem.length, avgRetry: memAvg },
      reductionPercent,
    };
  }
}

export const episodicMemoryStore = new EpisodicMemoryStore();
