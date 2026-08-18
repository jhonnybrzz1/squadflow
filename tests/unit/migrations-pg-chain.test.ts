import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Auditoria 2026-08-01 (A07): `0022_jobs_durable_tables.sql` fazia
 * `ALTER TABLE "retention_job_logs"` sem que nenhuma migration numerada criasse
 * a tabela. Com `ON_ERROR_STOP=1` a cadeia quebrava ali e um PostgreSQL vazio
 * não podia ser provisionado — mas nada no CI pegava, porque o dia a dia roda
 * SQLite com `ensureSchema` criando as tabelas em runtime.
 *
 * Este guard reproduz estaticamente o que `scripts/pg-smoke.sh` faz de verdade
 * (aplicar `migrations-pg/[0-9]*.sql` em ordem, sem `.down.sql` e sem
 * `final_migration.sql`) e falha se alguma migration tocar uma tabela que a
 * cadeia ainda não criou. Não substitui o pg-smoke — roda sem docker, então
 * pega a regressão antes.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'migrations-pg');

function chainFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d.*\.sql$/.test(file) && !file.endsWith('.down.sql'))
    .sort();
}

/** Remove comentários de linha para não casar SQL citado em comentário. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

function normalizeTable(raw: string): string {
  return raw
    .replace(/"/g, '')
    .replace(/^public\./, '')
    .toLowerCase();
}

const IDENT = '"?[a-z0-9_]+"?(?:\\.\"?[a-z0-9_]+"?)?';

describe('cadeia migrations-pg aplica do zero (auditoria A07)', () => {
  const files = chainFiles();

  it('encontra as migrations numeradas', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('nenhuma migration faz ALTER TABLE numa tabela que a cadeia ainda não criou', () => {
    const created = new Set<string>();
    const violations: string[] = [];

    for (const file of files) {
      const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));

      // Statements são avaliados na ordem em que aparecem no arquivo: uma
      // migration pode criar e alterar a mesma tabela.
      const statements = sql.split(';');
      for (const statement of statements) {
        const createMatch = statement.match(
          new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(${IDENT})`, 'i'),
        );
        if (createMatch) {
          created.add(normalizeTable(createMatch[1]));
          continue;
        }

        const alterMatch = statement.match(
          new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(${IDENT})`, 'i'),
        );
        if (alterMatch) {
          const table = normalizeTable(alterMatch[1]);
          // `ALTER TABLE IF EXISTS` é explicitamente tolerante a ausência.
          const tolerant = /alter\s+table\s+if\s+exists/i.test(statement);
          if (!created.has(table) && !tolerant) {
            violations.push(`${file}: ALTER TABLE "${table}" sem CREATE anterior na cadeia`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
