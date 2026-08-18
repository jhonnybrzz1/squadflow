import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  addLastSucceededDialectSql,
  hasLastSucceededDialect,
  idempotencySqliteStatements,
} from '../server/services/idempotency-schema';

function columns(sqlite: Database.Database): Array<{ name: string }> {
  return sqlite.prepare("PRAGMA table_info('idempotency_records')").all() as Array<{
    name: string;
  }>;
}

describe('SQLite idempotency schema bootstrap', () => {
  it('creates the complete table idempotently when it is missing', () => {
    const sqlite = new Database(':memory:');

    for (const statement of idempotencySqliteStatements) sqlite.exec(statement);
    for (const statement of idempotencySqliteStatements) sqlite.exec(statement);

    expect(hasLastSucceededDialect(columns(sqlite))).toBe(true);
    sqlite.close();
  });

  it('adds last_succeeded_dialect to a legacy table without losing rows', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE idempotency_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      INSERT INTO idempotency_records (key, created_at, expires_at)
      VALUES ('existing-key', 1, 2);
    `);

    for (const statement of idempotencySqliteStatements) sqlite.exec(statement);
    if (!hasLastSucceededDialect(columns(sqlite))) sqlite.exec(addLastSucceededDialectSql);

    expect(hasLastSucceededDialect(columns(sqlite))).toBe(true);
    expect(
      sqlite.prepare('SELECT key, last_succeeded_dialect FROM idempotency_records').get(),
    ).toEqual({ key: 'existing-key', last_succeeded_dialect: 'unknown' });
    sqlite.close();
  });
});
