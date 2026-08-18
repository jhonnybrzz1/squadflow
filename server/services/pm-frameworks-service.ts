/**
 * Demanda 10091 — catálogo local de frameworks de Product Discovery.
 *
 * O conteúdo vem de um clone local do repositório PMframeworks, importado por
 * `scripts/import-pmframeworks.ts` (sem GitHub API em runtime). Aqui só
 * persistimos e servimos. Mesmo padrão durável do resto do projeto: SQL bruto
 * via `dbHelper`, `ensureSchema()` idempotente, runner injetável, guard
 * `isPostgres` (feature local-only).
 */
import { sql, type SQL } from 'drizzle-orm';

import { dbHelper, isPostgres } from '../db';

export interface PmFrameworksDbRunner {
  run(query: SQL): Promise<void> | void;
  all<T = Record<string, unknown>>(query: SQL): Promise<T[]> | T[];
}

let runner: PmFrameworksDbRunner = dbHelper;

export function __setPmFrameworksRunnerForTests(custom: PmFrameworksDbRunner | null): void {
  runner = custom ?? dbHelper;
  pmFrameworksService.resetSchemaCacheForTests();
}

export const PM_FRAMEWORKS_CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS pm_frameworks (
    id TEXT PRIMARY KEY NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    content TEXT NOT NULL,
    version TEXT,
    -- 'framework' (método de discovery) x 'report' (relatório do projeto).
    category TEXT NOT NULL DEFAULT 'framework',
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Bancos criados antes da coluna: ALTER idempotente via try/catch no ensureSchema.
  `ALTER TABLE pm_frameworks ADD COLUMN category TEXT NOT NULL DEFAULT 'framework'`,
  `CREATE INDEX IF NOT EXISTS pm_frameworks_slug_idx ON pm_frameworks(slug)`,
] as const;

export interface PmFramework {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  content: string;
  version: string | null;
  category: string;
  importedAt: string;
}

interface PmFrameworkRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  content: string;
  version: string | null;
  category: string | null;
  imported_at: string;
}

function toFramework(r: PmFrameworkRow): PmFramework {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description ?? null,
    content: r.content,
    version: r.version ?? null,
    category: r.category ?? 'framework',
    importedAt: r.imported_at,
  };
}

/** Percorre a cadeia de `cause` procurando o erro de coluna duplicada. */
function isDuplicateColumnError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (/duplicate column/i.test(String((current as Error)?.message ?? ''))) return true;
    current = (current as { cause?: unknown })?.cause;
  }
  return false;
}

export class PmFrameworksService {
  private ensured = false;

  resetSchemaCacheForTests(): void {
    this.ensured = false;
  }

  async ensureSchema(): Promise<void> {
    if (this.ensured || isPostgres) return;
    for (const statement of PM_FRAMEWORKS_CREATE_STATEMENTS) {
      try {
        await runner.run(sql.raw(statement));
      } catch (error) {
        // O ALTER falha quando a coluna já existe — esperado e inofensivo.
        // O driver embrulha o erro (DrizzleError → SqliteError), então é preciso
        // percorrer a cadeia de `cause`; olhar só a mensagem externa não acha.
        if (!isDuplicateColumnError(error)) throw error;
      }
    }
    this.ensured = true;
  }

  /**
   * Upsert por `slug` — reimportar o mesmo framework atualiza conteúdo/versão
   * em vez de duplicar (o script de import é idempotente).
   */
  async upsert(entry: {
    slug: string;
    name: string;
    content: string;
    description?: string | null;
    version?: string | null;
    category?: string;
  }): Promise<void> {
    await this.ensureSchema();
    await runner.run(
      sql`INSERT INTO pm_frameworks (id, slug, name, description, content, version, category, imported_at)
          VALUES (${entry.slug}, ${entry.slug}, ${entry.name}, ${entry.description ?? null},
                  ${entry.content}, ${entry.version ?? null}, ${entry.category ?? 'framework'},
                  datetime('now'))
          ON CONFLICT(slug) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            content = excluded.content,
            version = excluded.version,
            category = excluded.category,
            imported_at = excluded.imported_at`,
    );
  }

  /** Lista sem o `content` (payload leve para a sidebar). */
  async list(): Promise<Array<Omit<PmFramework, 'content'>>> {
    await this.ensureSchema();
    const rows = await runner.all<Omit<PmFrameworkRow, 'content'>>(
      sql`SELECT id, slug, name, description, version, category, imported_at FROM pm_frameworks ORDER BY category ASC, name ASC`,
    );
    return rows.map((r) => {
      const { content: _drop, ...rest } = toFramework({ ...r, content: '' });
      return rest;
    });
  }

  async findBySlug(slug: string): Promise<PmFramework | null> {
    await this.ensureSchema();
    const rows = await runner.all<PmFrameworkRow>(
      sql`SELECT * FROM pm_frameworks WHERE slug = ${slug} LIMIT 1`,
    );
    return rows.length > 0 ? toFramework(rows[0]) : null;
  }
}

export const pmFrameworksService = new PmFrameworksService();
