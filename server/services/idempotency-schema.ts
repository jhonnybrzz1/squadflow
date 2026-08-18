import { sql } from 'drizzle-orm';
import { dbHelper, isPostgres } from '../db';
import { logger } from '../utils/logger';

export const idempotencySqliteStatements = [
  `CREATE TABLE IF NOT EXISTS idempotency_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_succeeded_dialect TEXT NOT NULL DEFAULT 'unknown'
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idempotency_records_key_unique
   ON idempotency_records(key)`,
] as const;

export const addLastSucceededDialectSql =
  "ALTER TABLE idempotency_records ADD COLUMN last_succeeded_dialect TEXT NOT NULL DEFAULT 'unknown'";

export function hasLastSucceededDialect(columns: Array<{ name: string }>): boolean {
  return columns.some((column) => column.name === 'last_succeeded_dialect');
}

/**
 * Local SQLite databases can predate either the table or migration 0020.
 * Reconcile both shapes before the document worker starts. PostgreSQL remains
 * migration-managed.
 */
export async function ensureIdempotencySchema(): Promise<void> {
  if (isPostgres) return;

  for (const statement of idempotencySqliteStatements) {
    await dbHelper.run(sql.raw(statement));
  }

  const columns = await dbHelper.all<{ name: string }>(
    sql`PRAGMA table_info('idempotency_records')`,
  );
  if (!hasLastSucceededDialect(columns)) {
    await dbHelper.run(sql.raw(addLastSucceededDialectSql));
  }

  logger.info('SQLite idempotency schema ready', {
    context: { table: 'idempotency_records', lastSucceededDialect: true },
  });
}
