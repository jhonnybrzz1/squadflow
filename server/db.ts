import { drizzle as drizzleSqlite, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleNeon, NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import Database from 'better-sqlite3';
import { SQL } from 'drizzle-orm';
import * as schemaSqlite from '@shared/schema';
import * as schemaPg from '@shared/schema-pg';
import { resolveDatabasePolicy } from './services/storage-policy';
import {
  dropDemandModeColumnIfExists,
  addDemandOriginColumnsIfMissing,
  addPromptVersionMetricsModelIfMissing,
} from './db/migrations';

const databasePolicy = resolveDatabasePolicy();
const DATABASE_URL = databasePolicy.databaseUrl;

// Postgres is the production source of truth. SQLite remains opt-in for dev/test.
export const isPostgres = databasePolicy.dialect === 'postgres';
export const databaseDialect = databasePolicy.dialect;

// Create appropriate database instance
const sqliteDb = !isPostgres ? new Database(DATABASE_URL) : null;
if (sqliteDb) {
  // Performance Fix T6: Optimize SQLite for concurrent reads and writes
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('synchronous = NORMAL');
  sqliteDb.pragma('busy_timeout = 5000');
  // Spec 10146: remove coluna mode (feature morta) de forma idempotente.
  dropDemandModeColumnIfExists(sqliteDb);
  // Demanda 10196: adiciona colunas origin/origin_metadata de forma idempotente.
  addDemandOriginColumnsIfMissing(sqliteDb);
  addPromptVersionMetricsModelIfMissing(sqliteDb);

  // H-10: enable foreign key enforcement. SQLite defaults to OFF — without
  // this, ON DELETE CASCADE clauses in the schema are silently ignored and
  // orphaned child rows accumulate. deleteDemand() works around this with
  // explicit child deletes, but FK enforcement is defense-in-depth: it
  // catches any FK violation at insert/delete time rather than allowing
  // inconsistent state. Note: PRAGMA foreign_keys is a no-op on Postgres
  // (enforcement is always on there).
  sqliteDb.pragma('foreign_keys = ON');
}
const neonClient = isPostgres ? neon(DATABASE_URL) : null;

// Pass dialect-specific schema to Drizzle so generated SQL matches the adapter.
// Schemas have identical column shapes; we cast to the SQLite types (canonical)
// so existing code typed against `@shared/schema` continues to compile.
const schema = schemaSqlite;

// H-27: Previously the export used `as unknown as BetterSQLite3Database<...>`,
// which erased the Postgres branch entirely — making TypeScript believe every
// call site has a synchronous SQLite client even when running on Neon. This is
// a type-safety illusion: Postgres methods are async, SQLite methods are sync,
// and the cast hides mismatches until runtime.
//
// Now we export the real union type `DbClient`. Call sites that need a
// specific dialect should narrow via `isPostgres`. The `db` export retains
// the cast for backward compatibility with existing code that calls sync
// SQLite-style methods, but `dbHelper` and `dbTransaction` are the
// recommended dialect-safe entry points.
export const db = (isPostgres
  ? drizzleNeon(neonClient!, { schema: schemaPg })
  : drizzleSqlite(sqliteDb!, { schema: schemaSqlite })) as unknown as BetterSQLite3Database<
  typeof schema
>;

// Unified database type for services — the actual runtime type of `db`.
// H-27: This is the type-safe view. Prefer `DbClient` over the cast `db`
// export in new code. Use `dbHelper` for dialect-agnostic run/all/get, or
// narrow with `isPostgres` when you need dialect-specific methods.
export type DbClient = NeonHttpDatabase<typeof schema> | BetterSQLite3Database<typeof schema>;

// H-27: type-safe accessor that returns the correctly-typed Drizzle instance
// for the active dialect. Use this in new code instead of casting `db`.
export function getDb(): DbClient {
  if (isPostgres) {
    return db as unknown as NeonHttpDatabase<typeof schema>;
  }
  return db as unknown as BetterSQLite3Database<typeof schema>;
}

/**
 * Database abstraction layer for RAG services
 * Provides unified API for both SQLite and PostgreSQL
 */
export const dbHelper = {
  /**
   * Execute a query that doesn't return results (CREATE, INSERT, UPDATE, DELETE)
   */
  async run(query: SQL): Promise<void> {
    if (isPostgres) {
      await (db as unknown as NeonHttpDatabase<typeof schema>).execute(query);
    } else {
      (db as unknown as BetterSQLite3Database<typeof schema>).run(query);
    }
  },

  /**
   * Execute a query and return all results
   */
  async all<T = Record<string, unknown>>(query: SQL): Promise<T[]> {
    if (isPostgres) {
      const result = await (db as unknown as NeonHttpDatabase<typeof schema>).execute(query);
      return (result as any).rows || result || [];
    } else {
      return (db as unknown as BetterSQLite3Database<typeof schema>).all(query) as T[];
    }
  },

  /**
   * Execute a query and return first result
   */
  async get<T = Record<string, unknown>>(query: SQL): Promise<T | undefined> {
    const results = await this.all<T>(query);
    return results[0];
  },

  /**
   * Check if using PostgreSQL
   */
  isPostgres,
};

export type TransactionCallback<T> = (tx: BetterSQLite3Database<typeof schema>) => Promise<T>;

// Tracks which raw SQLite connections currently have an open transaction, so
// re-entrant calls on the same connection run inline instead of issuing an
// illegal nested BEGIN. A WeakSet allows in-memory test databases to be GC'd.
type SqliteConnection = InstanceType<typeof Database>;
const sqliteTxConnections = new WeakSet<SqliteConnection>();

/**
 * Extracts the raw better-sqlite3 `Database` handle from a Drizzle instance.
 * Used to issue `BEGIN`/`COMMIT`/`ROLLBACK` on the same connection the Drizzle
 * statements execute against.
 */
function getRawSqlite(drizzleDb: BetterSQLite3Database<typeof schema>): SqliteConnection | null {
  const session = (drizzleDb as unknown as { session?: { client?: unknown } }).session;
  const raw = session?.client;
  return raw instanceof Database ? raw : null;
}

/**
 * Executes a callback inside a database transaction with real atomicity.
 *
 * PostgreSQL: uses a real Drizzle transaction (rolls back on throw).
 * SQLite (better-sqlite3): wraps the callback in an explicit
 * `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` on the connection backing `client`
 * (or the shared global connection when `client` is omitted) so a partial
 * failure rolls back every write. better-sqlite3 is synchronous and runs under
 * WAL with a single writer; the callback performs only DB work, so the
 * statements execute atomically between BEGIN and COMMIT. Re-entrant calls on
 * a connection that already has an open transaction run inline to avoid an
 * illegal nested BEGIN.
 *
 * Pass `client` when the caller owns its own Drizzle instance (e.g. tests with
 * an in-memory database) so the transaction wraps the correct connection.
 */
export async function dbTransaction<T>(
  callback: TransactionCallback<T>,
  client?: DbClient,
): Promise<T> {
  if (isPostgres) {
    const pgDb = (client ?? db) as unknown as NeonHttpDatabase<typeof schema>;
    return await pgDb.transaction(async (tx) => {
      return await callback(tx as unknown as BetterSQLite3Database<typeof schema>);
    });
  }

  // Resolve which Drizzle instance and raw connection to use.
  const drizzleDb = (client ?? db) as BetterSQLite3Database<typeof schema>;
  const raw = getRawSqlite(drizzleDb) ?? sqliteDb;

  // SQLite: run inline when already inside a transaction on this connection.
  if (!raw || sqliteTxConnections.has(raw)) {
    return await callback(drizzleDb);
  }

  sqliteTxConnections.add(raw);
  raw.exec('BEGIN IMMEDIATE');
  try {
    const result = await callback(drizzleDb);
    raw.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      raw.exec('ROLLBACK');
    } catch (_) {
      // ignore rollback errors — surface the original failure below
    }
    throw error;
  } finally {
    sqliteTxConnections.delete(raw);
  }
}
