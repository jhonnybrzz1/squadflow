/**
 * Demanda 10037 — paridade entre a migration de `artifacts` e o schema Drizzle.
 *
 * Contexto: a entrega original declarou a tabela em `shared/schema.ts` e criou
 * a migration, mas os testes de rota mockavam `../server/db` — nenhum deles
 * tocava uma tabela real. O `verifyDeployedSchema` do boot é que acusou
 * "Drift implantado: artifacts.* (table_missing)".
 *
 * Um teste não consegue garantir que a migration foi APLICADA no banco em uso
 * (isso é operação, e o `verifyDeployedSchema` já cobre). O que dá para
 * garantir aqui é que, quando aplicada, ela produz exatamente o que o código
 * espera — a metade do problema que vive no repositório.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { artifacts } from '../../shared/schema';

const MIGRATION = resolve(__dirname, '../../migrations/0037_add_artifacts.sql');

/** Nomes físicos das colunas declaradas no schema Drizzle. */
function schemaColumnNames(): string[] {
  const columns = (artifacts as unknown as { [k: symbol]: unknown })[
    Object.getOwnPropertySymbols(artifacts).find(
      (s) => s.description === 'drizzle:Columns',
    ) as symbol
  ] as Record<string, { name: string }>;

  return Object.values(columns)
    .map((c) => c.name)
    .sort();
}

function applyMigration(): Database.Database {
  const db = new Database(':memory:');
  // A migration referencia demands(id) por FK; a tabela precisa existir antes.
  db.exec('CREATE TABLE demands (id INTEGER PRIMARY KEY AUTOINCREMENT)');
  db.exec(readFileSync(MIGRATION, 'utf8'));
  return db;
}

describe('migration 0037 x shared/schema.ts', () => {
  it('cria a tabela artifacts', () => {
    const db = applyMigration();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'")
      .get();

    expect(row).toBeDefined();
    db.close();
  });

  it('as colunas batem exatamente com o schema Drizzle', () => {
    const db = applyMigration();
    const deployed = (db.prepare('PRAGMA table_info(artifacts)').all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();

    expect(deployed).toEqual(schemaColumnNames());
    db.close();
  });

  it('cria os índices por demanda e por data', () => {
    const db = applyMigration();
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='artifacts'")
        .all() as Array<{ name: string }>
    ).map((i) => i.name);

    expect(indexes).toContain('artifacts_demand_idx');
    expect(indexes).toContain('artifacts_created_idx');
    db.close();
  });

  it('é idempotente — aplicar duas vezes não falha', () => {
    const db = applyMigration();
    expect(() => db.exec(readFileSync(MIGRATION, 'utf8'))).not.toThrow();
    db.close();
  });

  it('aceita insert/select no formato que o artifact-store emite', () => {
    const db = applyMigration();
    db.exec('INSERT INTO demands (id) VALUES (1)');
    db.prepare(
      'INSERT INTO artifacts (id, demand_id, type, source, created_at) VALUES (?,?,?,?,?)',
    ).run('a1', 1, 'flowchart', 'flowchart TD\n  N0["ok"]', 1700000000);

    const rows = db
      .prepare('SELECT * FROM artifacts WHERE demand_id = ? ORDER BY created_at DESC')
      .all(1) as Array<{ type: string; source: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('flowchart');
    expect(rows[0].source).toContain('flowchart TD');
    db.close();
  });

  it('apaga os artefatos junto com a demanda (ON DELETE CASCADE)', () => {
    const db = applyMigration();
    db.pragma('foreign_keys = ON');
    db.exec('INSERT INTO demands (id) VALUES (1)');
    db.prepare(
      'INSERT INTO artifacts (id, demand_id, type, source, created_at) VALUES (?,?,?,?,?)',
    ).run('a1', 1, 'flowchart', 'flowchart TD', 1700000000);

    db.exec('DELETE FROM demands WHERE id = 1');

    expect(db.prepare('SELECT COUNT(*) c FROM artifacts').get()).toEqual({ c: 0 });
    db.close();
  });
});
