import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  APPROVED_MIGRATIONS,
  UNSAFE_LEGACY_MIGRATIONS,
  UnknownSchemaStateError,
  buildMigrationPlan,
  emptySchemaState,
  inspectSqliteState,
  runMigrationPlan,
  type MigrationDialect,
  type SchemaState,
} from '../../scripts/audit-remediation-migrations';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeRepo(files: readonly string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aichatflow-migrations-'));
  temporaryDirectories.push(root);
  for (const file of files) {
    const absolutePath = path.join(root, file);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, '-- test migration');
  }
  return root;
}

function manifestFiles(dialect: MigrationDialect): string[] {
  return APPROVED_MIGRATIONS[dialect].map((entry) => entry.file);
}

function stateWithTables(...tableNames: string[]): SchemaState {
  return {
    tables: new Set(tableNames),
    columns: new Map(tableNames.map((table) => [table, new Set(['id'])])),
    indexes: new Set(),
  };
}

describe('approved audit-remediation migration manifest', () => {
  it.each<MigrationDialect>(['sqlite', 'postgres'])(
    'excludes immutable unsafe legacy migrations for %s',
    (dialect) => {
      const approved = new Set(manifestFiles(dialect));
      for (const unsafe of UNSAFE_LEGACY_MIGRATIONS[dialect]) {
        expect(approved.has(unsafe)).toBe(false);
        expect(fs.existsSync(path.resolve(unsafe))).toBe(true);
      }
    },
  );

  it.each<MigrationDialect>(['sqlite', 'postgres'])(
    'plans the safe base migrations for a clean %s schema',
    (dialect) => {
      const root = makeRepo(manifestFiles(dialect));
      expect(
        buildMigrationPlan(dialect, emptySchemaState(), root).map((entry) => entry.file),
      ).toEqual(manifestFiles(dialect));
    },
  );

  it.each<MigrationDialect>(['sqlite', 'postgres'])(
    'skips base migrations when the %s target schema already exists',
    (dialect) => {
      const root = makeRepo(manifestFiles(dialect));
      const state = stateWithTables(
        'model_aliases',
        'model_candidates',
        'model_history',
        'demand_external_docs',
      );
      expect(buildMigrationPlan(dialect, state, root).map((entry) => entry.id)).toEqual([
        'candidate-partial-uniqueness',
        'model-alias-rollback-cooldown',
        'external-doc-current-lease',
      ]);
    },
  );

  it('fails closed when only part of the Model Registry schema exists', () => {
    const root = makeRepo(manifestFiles('sqlite'));
    expect(() => buildMigrationPlan('sqlite', stateWithTables('model_aliases'), root)).toThrow(
      UnknownSchemaStateError,
    );
  });

  it('fails closed when an approved file is missing', () => {
    const root = makeRepo([manifestFiles('sqlite')[0]]);
    expect(() => buildMigrationPlan('sqlite', emptySchemaState(), root)).toThrow(
      /Approved migration file is missing/,
    );
  });

  it('does not execute SQL in dry-run mode', async () => {
    const root = makeRepo(manifestFiles('sqlite'));
    let executions = 0;
    const plan = await runMigrationPlan({
      dialect: 'sqlite',
      state: emptySchemaState(),
      repoRoot: root,
      dryRun: true,
      executor: { execute: () => void executions++ },
    });
    expect(plan).toHaveLength(5);
    expect(executions).toBe(0);
  });

  it('inspects SQLite tables, columns and indexes without executing DDL', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec('CREATE TABLE model_aliases (id INTEGER PRIMARY KEY, alias TEXT NOT NULL)');
      sqlite.exec('CREATE INDEX idx_model_aliases_alias ON model_aliases(alias)');
      const state = inspectSqliteState(sqlite);
      expect(state.tables.has('model_aliases')).toBe(true);
      expect(state.columns.get('model_aliases')).toEqual(new Set(['id', 'alias']));
      expect(state.indexes.has('idx_model_aliases_alias')).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it('preserves SQLite candidate rows, supersedes older duplicates and is repeatable', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(fs.readFileSync(path.resolve('migrations/0025_add_model_registry.sql'), 'utf8'));
      const insert = sqlite.prepare(`
        INSERT INTO model_candidates (
          alias, family, provider, current_model_id, candidate_model_id,
          status, discovered_at
        ) VALUES (?, 'reasoning', 'openrouter', 'old-model', 'new-model', ?, ?)
      `);
      insert.run('default', 'validated', 100);
      insert.run('default', 'rejected', 200);
      insert.run('default', 'validated', 300);

      const before = sqlite.prepare('SELECT COUNT(*) AS count FROM model_candidates').get() as {
        count: number;
      };
      const migration = fs.readFileSync(
        path.resolve('migrations/0030_reconcile_candidate_uniqueness.sql'),
        'utf8',
      );
      sqlite.exec(migration);
      sqlite.exec(migration);

      const after = sqlite.prepare('SELECT COUNT(*) AS count FROM model_candidates').get() as {
        count: number;
      };
      const statuses = sqlite
        .prepare('SELECT id, status FROM model_candidates ORDER BY id')
        .all() as Array<{ id: number; status: string }>;
      expect(after.count).toBe(before.count);
      expect(statuses).toEqual([
        { id: 1, status: 'superseded' },
        { id: 2, status: 'superseded' },
        { id: 3, status: 'validated' },
      ]);
      expect(() => insert.run('default', 'validated', 400)).toThrow(/UNIQUE constraint failed/);
    } finally {
      sqlite.close();
    }
  });

  it('keeps the PostgreSQL successor lossless and transactional', () => {
    const sql = fs.readFileSync(
      path.resolve('migrations-pg/0014_reconcile_candidate_uniqueness.sql'),
      'utf8',
    );
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).toMatch(/BEGIN;/);
    expect(sql).toMatch(/COMMIT;/);
    expect(sql).toMatch(/status <> 'superseded'/);
  });

  it('adds all rollback state columns on a fresh SQLite schema and is runner-repeatable', async () => {
    const sqlite = new Database(':memory:');
    try {
      await runMigrationPlan({
        dialect: 'sqlite',
        state: inspectSqliteState(sqlite),
        executor: { execute: (sql) => sqlite.exec(sql) },
      });
      const appliedState = inspectSqliteState(sqlite);
      expect(appliedState.columns.get('model_aliases')?.has('failure_count')).toBe(true);
      expect(appliedState.columns.get('model_aliases')?.has('last_failure_at')).toBe(true);
      expect(appliedState.columns.get('model_aliases')?.has('last_rollback_at')).toBe(true);
      expect(
        await runMigrationPlan({
          dialect: 'sqlite',
          state: appliedState,
          executor: { execute: (sql) => sqlite.exec(sql) },
        }),
      ).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('adds only last_rollback_at to a previously upgraded SQLite schema', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(fs.readFileSync(path.resolve('migrations/0025_add_model_registry.sql'), 'utf8'));
      sqlite.exec(
        fs.readFileSync(path.resolve('migrations/0027_demand_external_docs.sql'), 'utf8'),
      );
      sqlite.exec(
        fs.readFileSync(path.resolve('migrations/0028_model_alias_failure_state.sql'), 'utf8'),
      );
      await runMigrationPlan({
        dialect: 'sqlite',
        state: inspectSqliteState(sqlite),
        executor: { execute: (sql) => sqlite.exec(sql) },
      });
      const columns = inspectSqliteState(sqlite).columns.get('model_aliases');
      expect(columns?.has('failure_count')).toBe(true);
      expect(columns?.has('last_failure_at')).toBe(true);
      expect(columns?.has('last_rollback_at')).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it('uses idempotent PostgreSQL column additions for rollback state', () => {
    const sql = fs.readFileSync(
      path.resolve('migrations-pg/0015_add_model_alias_rollback_cooldown.sql'),
      'utf8',
    );
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(3);
    expect(sql).toMatch(/last_rollback_at TIMESTAMP/);
  });

  it('preserves all SQLite external documents and selects one deterministic current row', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(fs.readFileSync(path.resolve('migrations/0025_add_model_registry.sql'), 'utf8'));
      sqlite.exec(
        fs.readFileSync(path.resolve('migrations/0027_demand_external_docs.sql'), 'utf8'),
      );
      const insert = sqlite.prepare(`
        INSERT INTO demand_external_docs (
          demand_id, doc_type, external_url, docu_mente_url, status, created_at, completed_at
        ) VALUES (7, 'epic', ?, ?, ?, ?, ?)
      `);
      insert.run('https://docs/old-success', 'http://localhost:3000', 'success', 100, 110);
      insert.run('https://docs/new-success', 'http://localhost:3001', 'success', 200, 210);
      insert.run(null, 'http://localhost:3002', 'failed', 300, 310);

      const before = sqlite.prepare('SELECT COUNT(*) AS count FROM demand_external_docs').get() as {
        count: number;
      };
      await runMigrationPlan({
        dialect: 'sqlite',
        state: inspectSqliteState(sqlite),
        executor: { execute: (sql) => sqlite.exec(sql) },
      });
      const after = sqlite.prepare('SELECT COUNT(*) AS count FROM demand_external_docs').get() as {
        count: number;
      };
      const rows = sqlite
        .prepare('SELECT id, is_current AS isCurrent FROM demand_external_docs ORDER BY id')
        .all() as Array<{ id: number; isCurrent: number }>;
      expect(after.count).toBe(before.count);
      expect(rows).toEqual([
        { id: 1, isCurrent: 0 },
        { id: 2, isCurrent: 1 },
        { id: 3, isCurrent: 0 },
      ]);
      expect(inspectSqliteState(sqlite).columns.get('demand_external_docs')).toEqual(
        expect.objectContaining({ has: expect.any(Function) }),
      );
      expect(
        inspectSqliteState(sqlite).columns.get('demand_external_docs')?.has('operation_token'),
      ).toBe(true);
      expect(
        inspectSqliteState(sqlite).columns.get('demand_external_docs')?.has('lease_expires_at'),
      ).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it('keeps PostgreSQL external-doc reconciliation lossless and idempotent', () => {
    const sql = fs.readFileSync(
      path.resolve('migrations-pg/0016_reconcile_external_docs.sql'),
      'utf8',
    );
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(3);
    expect(sql).toMatch(/WHERE is_current = TRUE/);
  });

  it('reconciles a SQLite schema that already has legacy constraint effects', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(fs.readFileSync(path.resolve('migrations/0025_add_model_registry.sql'), 'utf8'));
      sqlite.exec(
        fs.readFileSync(path.resolve('migrations/0026_unique_candidate_per_alias.sql'), 'utf8'),
      );
      sqlite.exec(
        fs.readFileSync(path.resolve('migrations/0027_demand_external_docs.sql'), 'utf8'),
      );
      sqlite.exec(
        fs.readFileSync(path.resolve('migrations/0028_model_alias_failure_state.sql'), 'utf8'),
      );
      sqlite.exec(
        fs.readFileSync(
          path.resolve('migrations/0029_demand_external_docs_fix_unique.sql'),
          'utf8',
        ),
      );

      await runMigrationPlan({
        dialect: 'sqlite',
        state: inspectSqliteState(sqlite),
        executor: {
          execute: (sql) => sqlite.exec(sql),
          rollback: () => sqlite.inTransaction && sqlite.exec('ROLLBACK'),
        },
      });

      const state = inspectSqliteState(sqlite);
      expect(state.indexes.has('idx_model_candidates_alias_candidate_current')).toBe(true);
      expect(state.indexes.has('demand_external_docs_current_idx')).toBe(true);
      expect(state.columns.get('model_aliases')?.has('last_rollback_at')).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it('rolls back an injected SQLite DDL failure without partial reconciliation', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(fs.readFileSync(path.resolve('migrations/0025_add_model_registry.sql'), 'utf8'));
      sqlite.exec(
        fs.readFileSync(path.resolve('migrations/0027_demand_external_docs.sql'), 'utf8'),
      );
      const insert = sqlite.prepare(`
        INSERT INTO model_candidates (
          alias, family, provider, current_model_id, candidate_model_id, status, discovered_at
        ) VALUES ('default', 'reasoning', 'openrouter', 'old', 'new', 'validated', ?)
      `);
      insert.run(100);
      insert.run(200);

      const root = makeRepo(manifestFiles('sqlite'));
      for (const file of manifestFiles('sqlite')) {
        fs.copyFileSync(path.resolve(file), path.join(root, file));
      }
      const candidatePath = path.join(root, 'migrations/0030_reconcile_candidate_uniqueness.sql');
      fs.writeFileSync(
        candidatePath,
        fs
          .readFileSync(candidatePath, 'utf8')
          .replace(
            /CREATE UNIQUE INDEX IF NOT EXISTS idx_model_candidates_alias_candidate_current[\s\S]*?WHERE status <> 'superseded';/,
            'CREATE UNIQUE INDEX injected_failure ON table_that_does_not_exist(id);',
          ),
      );

      await expect(
        runMigrationPlan({
          dialect: 'sqlite',
          state: inspectSqliteState(sqlite),
          repoRoot: root,
          executor: {
            execute: (sql) => sqlite.exec(sql),
            rollback: () => sqlite.inTransaction && sqlite.exec('ROLLBACK'),
          },
        }),
      ).rejects.toThrow(/no such table/);

      const rows = sqlite
        .prepare('SELECT status FROM model_candidates ORDER BY id')
        .all() as Array<{ status: string }>;
      expect(rows).toEqual([{ status: 'validated' }, { status: 'validated' }]);
      const state = inspectSqliteState(sqlite);
      expect(state.indexes.has('idx_model_candidates_alias_candidate')).toBe(true);
      expect(state.indexes.has('idx_model_candidates_alias_candidate_current')).toBe(false);
      expect(sqlite.inTransaction).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});
