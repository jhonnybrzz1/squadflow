#!/usr/bin/env tsx

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type MigrationDialect = 'sqlite' | 'postgres';

export interface SchemaState {
  tables: ReadonlySet<string>;
  columns: ReadonlyMap<string, ReadonlySet<string>>;
  indexes: ReadonlySet<string>;
}

export interface MigrationEntry {
  id: string;
  file: string;
  phase: 'base' | 'corrective';
  appliesWhen?: (state: SchemaState) => boolean;
}

export interface MigrationExecutor {
  execute(sql: string): void | Promise<void>;
  rollback?(): void | Promise<void>;
}

export const UNSAFE_LEGACY_MIGRATIONS = Object.freeze({
  sqlite: [
    'migrations/0026_unique_candidate_per_alias.sql',
    'migrations/0028_model_alias_failure_state.sql',
    'migrations/0029_demand_external_docs_fix_unique.sql',
  ],
  postgres: [
    'migrations-pg/0010_unique_candidate_per_alias.sql',
    'migrations-pg/0012_model_alias_failure_state.sql',
    'migrations-pg/0013_demand_external_docs_fix_unique.sql',
  ],
} satisfies Record<MigrationDialect, readonly string[]>);

const MODEL_REGISTRY_TABLES = ['model_aliases', 'model_candidates', 'model_history'] as const;

export const APPROVED_MIGRATIONS: Record<MigrationDialect, readonly MigrationEntry[]> = {
  sqlite: [
    {
      id: 'model-registry-base',
      file: 'migrations/0025_add_model_registry.sql',
      phase: 'base',
      appliesWhen: (state) => !state.tables.has('model_aliases'),
    },
    {
      id: 'external-docs-base',
      file: 'migrations/0027_demand_external_docs.sql',
      phase: 'base',
      appliesWhen: (state) => !state.tables.has('demand_external_docs'),
    },
    {
      id: 'candidate-partial-uniqueness',
      file: 'migrations/0030_reconcile_candidate_uniqueness.sql',
      phase: 'corrective',
      appliesWhen: (state) => !state.indexes.has('idx_model_candidates_alias_candidate_current'),
    },
    {
      id: 'model-alias-rollback-cooldown',
      file: 'migrations/0031_add_model_alias_rollback_cooldown.sql',
      phase: 'corrective',
      appliesWhen: (state) =>
        !state.columns.get('model_aliases')?.has('last_rollback_at') ||
        !state.columns.get('model_aliases')?.has('failure_count') ||
        !state.columns.get('model_aliases')?.has('last_failure_at'),
    },
    {
      id: 'external-doc-current-lease',
      file: 'migrations/0032_reconcile_external_docs.sql',
      phase: 'corrective',
      appliesWhen: (state) =>
        !state.indexes.has('demand_external_docs_current_idx') ||
        !state.columns.get('demand_external_docs')?.has('is_current') ||
        !state.columns.get('demand_external_docs')?.has('operation_token') ||
        !state.columns.get('demand_external_docs')?.has('lease_expires_at'),
    },
  ],
  postgres: [
    {
      id: 'model-registry-base',
      file: 'migrations-pg/0009_add_model_registry.sql',
      phase: 'base',
      appliesWhen: (state) => !state.tables.has('model_aliases'),
    },
    {
      id: 'external-docs-base',
      file: 'migrations-pg/0011_demand_external_docs.sql',
      phase: 'base',
      appliesWhen: (state) => !state.tables.has('demand_external_docs'),
    },
    {
      id: 'candidate-partial-uniqueness',
      file: 'migrations-pg/0014_reconcile_candidate_uniqueness.sql',
      phase: 'corrective',
      appliesWhen: (state) => !state.indexes.has('idx_model_candidates_alias_candidate_current'),
    },
    {
      id: 'model-alias-rollback-cooldown',
      file: 'migrations-pg/0015_add_model_alias_rollback_cooldown.sql',
      phase: 'corrective',
      appliesWhen: (state) =>
        !state.columns.get('model_aliases')?.has('last_rollback_at') ||
        !state.columns.get('model_aliases')?.has('failure_count') ||
        !state.columns.get('model_aliases')?.has('last_failure_at'),
    },
    {
      id: 'external-doc-current-lease',
      file: 'migrations-pg/0016_reconcile_external_docs.sql',
      phase: 'corrective',
      appliesWhen: (state) =>
        !state.indexes.has('demand_external_docs_current_idx') ||
        !state.columns.get('demand_external_docs')?.has('is_current') ||
        !state.columns.get('demand_external_docs')?.has('operation_token') ||
        !state.columns.get('demand_external_docs')?.has('lease_expires_at'),
    },
  ],
};

export class UnknownSchemaStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownSchemaStateError';
  }
}

export function emptySchemaState(): SchemaState {
  return { tables: new Set(), columns: new Map(), indexes: new Set() };
}

export function assertKnownSchemaState(state: SchemaState): void {
  const presentModelTables = MODEL_REGISTRY_TABLES.filter((table) => state.tables.has(table));
  if (
    presentModelTables.length !== 0 &&
    presentModelTables.length !== MODEL_REGISTRY_TABLES.length
  ) {
    throw new UnknownSchemaStateError(
      `Partial Model Registry schema: found ${presentModelTables.join(', ') || 'none'}; expected all or none`,
    );
  }

  for (const [table, columns] of state.columns) {
    if (!state.tables.has(table)) {
      throw new UnknownSchemaStateError(`Columns reported for missing table: ${table}`);
    }
    if (columns.size === 0) {
      throw new UnknownSchemaStateError(`Table has no inspectable columns: ${table}`);
    }
  }
}

export function buildMigrationPlan(
  dialect: MigrationDialect,
  state: SchemaState,
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
): MigrationEntry[] {
  assertKnownSchemaState(state);
  const manifest = APPROVED_MIGRATIONS[dialect];
  const forbidden = new Set(UNSAFE_LEGACY_MIGRATIONS[dialect]);

  for (const entry of manifest) {
    if (forbidden.has(entry.file)) {
      throw new Error(`Unsafe legacy migration is present in approved manifest: ${entry.file}`);
    }
    if (!fs.existsSync(path.join(repoRoot, entry.file))) {
      throw new Error(`Approved migration file is missing: ${entry.file}`);
    }
  }

  return manifest.filter((entry) => entry.appliesWhen?.(state) ?? true);
}

export async function runMigrationPlan(options: {
  dialect: MigrationDialect;
  state: SchemaState;
  executor: MigrationExecutor;
  dryRun?: boolean;
  repoRoot?: string;
}): Promise<MigrationEntry[]> {
  const repoRoot =
    options.repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const plan = buildMigrationPlan(options.dialect, options.state, repoRoot);
  if (options.dryRun) return plan;

  for (const entry of plan) {
    const source = fs.readFileSync(path.join(repoRoot, entry.file), 'utf8');
    const sql = renderMigrationSql(options.dialect, entry, options.state, source);
    try {
      await options.executor.execute(sql);
    } catch (error) {
      await options.executor.rollback?.();
      throw error;
    }
  }
  return plan;
}

export function renderMigrationSql(
  dialect: MigrationDialect,
  entry: MigrationEntry,
  state: SchemaState,
  source: string,
): string {
  if (dialect !== 'sqlite') {
    return source;
  }

  return source.replace(
    /-- @if-column-missing ([a-z_]+)\.([a-z_]+)\n([^\n]+;)/g,
    (_match, table: string, column: string, statement: string) =>
      state.columns.get(table)?.has(column) ? '' : statement,
  );
}

interface SqliteDatabaseLike {
  prepare(sql: string): { all(): Array<Record<string, unknown>> };
}

export function inspectSqliteState(database: SqliteDatabaseLike): SchemaState {
  const tableRows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  const indexRows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all();
  const tables = new Set(tableRows.map((row) => String(row.name)));
  const columns = new Map<string, Set<string>>();

  for (const table of tables) {
    const escapedTable = table.replaceAll("'", "''");
    const columnRows = database.prepare(`PRAGMA table_info('${escapedTable}')`).all();
    columns.set(table, new Set(columnRows.map((row) => String(row.name))));
  }

  return {
    tables,
    columns,
    indexes: new Set(indexRows.map((row) => String(row.name))),
  };
}

function parseCliArgs(argv: string[]): { dialect: MigrationDialect; dryRun: boolean } {
  const dialectArg = argv.find((value) => value.startsWith('--dialect='));
  const dialect = dialectArg?.split('=')[1] ?? 'sqlite';
  if (dialect !== 'sqlite' && dialect !== 'postgres') {
    throw new Error(`Unsupported dialect: ${dialect}`);
  }
  return { dialect, dryRun: argv.includes('--dry-run') };
}

async function main(): Promise<void> {
  const { dialect, dryRun } = parseCliArgs(process.argv.slice(2));
  if (!dryRun) {
    throw new Error(
      'Apply mode requires an explicit database adapter and is intentionally unavailable in T002',
    );
  }

  const state = emptySchemaState();
  const plan = buildMigrationPlan(dialect, state);
  process.stdout.write(
    `${JSON.stringify({ dialect, dryRun: true, migrations: plan.map((entry) => entry.file) }, null, 2)}\n`,
  );
}

const isDirectExecution = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false;

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
