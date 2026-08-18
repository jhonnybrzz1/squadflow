import { logger } from '../utils/logger';
import { SQL } from 'drizzle-orm';
import type { DbClient } from '../db';

interface DatabaseDriver {
  run?: (query: SQL) => void | Promise<void>;
  execute?: (query: SQL) => Promise<unknown>;
  all?: (query: SQL) => unknown;
}

interface QueryResult {
  rows?: unknown[];
}

/**
 * Executes a raw SQL command in a driver-agnostic way for Drizzle.
 * Replaces db.run() which is better-sqlite3 specific.
 */
export async function dbRun(db: DbClient, query: SQL): Promise<void> {
  const driver = db as unknown as DatabaseDriver;
  try {
    if (typeof driver.run === 'function') {
      driver.run(query);
    } else if (typeof driver.execute === 'function') {
      await driver.execute(query);
    } else {
      throw new Error('dbRun: driver has neither run() nor execute()');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cause =
      (error as { cause?: { message?: string } })?.cause?.message ||
      String((error as { cause?: unknown })?.cause || '');
    const combinedMessage = (message + ' ' + cause).toLowerCase();

    if (
      combinedMessage.includes('duplicate column name') ||
      combinedMessage.includes('already exists') ||
      combinedMessage.includes('column already exists')
    ) {
      // Silently ignore schema migration overlaps
      return;
    }
    logger.error('Error in dbRun:', error);
    throw error;
  }
}

/**
 * Escapes special LIKE/ILIKE wildcard characters (`%` and `_`) in a user-provided
 * string so it is matched as a literal. Use with `ESCAPE '\'` when the query
 * needs literal matching, or to prevent user input from changing LIKE semantics.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * Executes a raw SQL query and returns all rows in a driver-agnostic way.
 * Replaces db.all() which is better-sqlite3 specific.
 */
export async function dbAll<T>(db: DbClient, query: SQL): Promise<T[]> {
  const driver = db as unknown as DatabaseDriver;
  try {
    if (typeof driver.all === 'function') {
      return driver.all(query) as T[];
    }
    if (typeof driver.execute === 'function') {
      const result = await driver.execute(query);
      // Drizzle execute returns different structures depending on the driver
      if (Array.isArray(result)) return result as T[];
      if (result && typeof result === 'object' && 'rows' in result) {
        return (result as QueryResult).rows as T[];
      }
      return result as unknown as T[];
    }
    throw new Error('dbAll: driver has neither all() nor execute()');
  } catch (error) {
    logger.error('Error in dbAll:', error);
    throw error;
  }
}
