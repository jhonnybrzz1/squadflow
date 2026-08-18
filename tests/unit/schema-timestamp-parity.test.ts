import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import * as sqliteSchema from '../../shared/schema';
import * as pgSchema from '../../shared/schema-pg';

/**
 * Paridade de colunas temporais entre os dois dialetos.
 *
 * A suíte mocka o banco na maior parte dos casos, então uma coluna que existe
 * num dialeto e não no outro passa despercebida até explodir em produção no
 * dialeto menos exercitado. Este teste compara os schemas declarados —
 * primeiro a existência da coluna (falha dura, sem exceção possível), depois o
 * tipo (divergência tolerada só com justificativa registrada abaixo).
 */

/** `chave` = `<tabela_sql>.<coluna_sql>` */
const TYPE_DIVERGENCE_ALLOWLIST = new Map<string, string>([
  [
    'backlog_activities.created_at',
    'Auditoria 2026-08-01 (A08): a coluna implantada pela migration 0044 é TEXT ' +
      "com datetime('now'); a declaração SQLite reflete a coluna real e a " +
      'normalização para ISO vive no serviço. No Postgres é timestamp.',
  ],
  [
    'backlog_activities.updated_at',
    'Auditoria 2026-08-01 (A08): mesmo caso de backlog_activities.created_at.',
  ],
]);

type AnyTable = SQLiteTable | PgTable;

function collectTables(
  mod: Record<string, unknown>,
  dialect: 'sqlite' | 'pg',
): Map<string, AnyTable> {
  const out = new Map<string, AnyTable>();
  for (const value of Object.values(mod)) {
    const isTable = dialect === 'sqlite' ? is(value, SQLiteTable) : is(value, PgTable);
    if (isTable) out.set(getTableName(value as AnyTable), value as AnyTable);
  }
  return out;
}

/** Colunas cujo nome SQL termina em `_at` — a convenção temporal do schema. */
function temporalColumns(table: AnyTable): Map<string, string> {
  const out = new Map<string, string>();
  for (const column of Object.values(getTableColumns(table))) {
    if (/_at$/.test(column.name)) out.set(column.name, column.columnType);
  }
  return out;
}

/** Um tipo é temporal de verdade quando o dialeto o armazena como timestamp. */
function isTemporalType(columnType: string): boolean {
  return columnType.includes('Timestamp');
}

const sqliteTables = collectTables(sqliteSchema, 'sqlite');
const pgTables = collectTables(pgSchema, 'pg');
const sharedTableNames = [...sqliteTables.keys()].filter((name) => pgTables.has(name)).sort();

describe('paridade de colunas temporais entre SQLite e Postgres', () => {
  it('encontra tabelas declaradas nos dois dialetos (guarda contra introspecção quebrada)', () => {
    expect(sharedTableNames.length).toBeGreaterThan(0);
  });

  it.each(sharedTableNames)('%s declara as mesmas colunas _at nos dois dialetos', (tableName) => {
    const sqliteColumns = temporalColumns(sqliteTables.get(tableName)!);
    const pgColumns = temporalColumns(pgTables.get(tableName)!);

    const onlySqlite = [...sqliteColumns.keys()].filter((c) => !pgColumns.has(c)).sort();
    const onlyPg = [...pgColumns.keys()].filter((c) => !sqliteColumns.has(c)).sort();

    // Coluna ausente num dialeto não tem allowlist: é sempre defeito.
    expect({ onlySqlite, onlyPg }).toEqual({ onlySqlite: [], onlyPg: [] });
  });

  it.each(sharedTableNames)('%s mantém o tipo temporal alinhado ou justificado', (tableName) => {
    const sqliteColumns = temporalColumns(sqliteTables.get(tableName)!);
    const pgColumns = temporalColumns(pgTables.get(tableName)!);

    const unjustified: string[] = [];
    for (const [columnName, sqliteType] of sqliteColumns) {
      const pgType = pgColumns.get(columnName);
      if (!pgType) continue; // coberto pelo teste de existência
      if (isTemporalType(sqliteType) === isTemporalType(pgType)) continue;
      if (TYPE_DIVERGENCE_ALLOWLIST.has(`${tableName}.${columnName}`)) continue;
      unjustified.push(`${tableName}.${columnName} (sqlite=${sqliteType}, pg=${pgType})`);
    }

    expect(unjustified).toEqual([]);
  });

  it('não acumula entradas obsoletas na allowlist', () => {
    const stale: string[] = [];
    for (const key of TYPE_DIVERGENCE_ALLOWLIST.keys()) {
      const [tableName, columnName] = key.split('.');
      const sqliteType = sqliteTables.has(tableName)
        ? temporalColumns(sqliteTables.get(tableName)!).get(columnName)
        : undefined;
      const pgType = pgTables.has(tableName)
        ? temporalColumns(pgTables.get(tableName)!).get(columnName)
        : undefined;

      // A entrada só se justifica enquanto a divergência existir de fato.
      if (!sqliteType || !pgType || isTemporalType(sqliteType) === isTemporalType(pgType)) {
        stale.push(key);
      }
    }

    expect(stale).toEqual([]);
  });
});
