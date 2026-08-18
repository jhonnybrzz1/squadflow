/**
 * Drizzle helpers for writing dialect-agnostic services that work with both
 * SQLite and PostgreSQL via the unified DbClient union type.
 *
 * Drizzle does not expose a common writer/reader type across the two
 * adapters; these aliases avoid `any` on the public surface while keeping
 * the call sites typed.
 *
 * Pattern extracted from orchestration-runtime.ts.
 */

import type { DbClient } from '../db';

type DrizzleExecutable = Promise<unknown> | { then: PromiseLike<unknown>['then'] };
interface DrizzleTable {
  readonly _: unknown;
}

export interface DrizzleWriter {
  insert(table: DrizzleTable): {
    values(v: Record<string, unknown>): DrizzleExecutable & {
      onConflictDoNothing?(): DrizzleExecutable;
      returning?(columns?: Record<string, unknown>): DrizzleExecutable;
    };
  };
  update(table: DrizzleTable): {
    set(v: Record<string, unknown>): {
      where(cond: unknown): DrizzleExecutable & {
        returning?(columns?: Record<string, unknown>): DrizzleExecutable;
      };
    };
  };
}

interface DrizzleQuery {
  where(cond: unknown): DrizzleQuery;
  orderBy(...conds: unknown[]): DrizzleQuery;
  limit(n: number): DrizzleQuery;
}

export interface DrizzleReader {
  select(): { from(table: DrizzleTable): DrizzleQuery };
  select(columns: unknown): { from(table: DrizzleTable): DrizzleQuery };
}

/**
 * Casts a DbClient to a DrizzleWriter for insert/update operations.
 * The runtime behavior is identical; this cast only resolves the union type.
 */
export function asWriter(db: DbClient): DrizzleWriter {
  return db as unknown as DrizzleWriter;
}

/**
 * Casts a DbClient to a DrizzleReader for select operations.
 */
export function asReader(db: DbClient): DrizzleReader {
  return db as unknown as DrizzleReader;
}
