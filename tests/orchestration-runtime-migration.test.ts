import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const UP = join(MIGRATIONS_DIR, '0024_add_orchestration_runtime.sql');
const DOWN = join(MIGRATIONS_DIR, '0024_add_orchestration_runtime.down.sql');

const ORCH_TABLES = [
  'orchestration_runs',
  'agent_turns',
  'agent_tool_calls',
  'orchestration_events',
];

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return Boolean(row);
}

describe('Migration 0024 orchestration runtime (rollback)', () => {
  let db: Database.Database | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it('aplica a up migration criando as 4 tabelas e a down migration removendo-as', () => {
    db = new Database(':memory:');
    // Baseline mínima para a FK demand_id (a up migration referencia demands).
    db.exec('CREATE TABLE demands (id INTEGER PRIMARY KEY AUTOINCREMENT);');

    const upSql = readFileSync(UP, 'utf-8');
    db.exec(upSql);
    for (const table of ORCH_TABLES) {
      expect(tableExists(db, table), `tabela ${table} deveria existir após up`).toBe(true);
    }

    const downSql = readFileSync(DOWN, 'utf-8');
    db.exec(downSql);
    for (const table of ORCH_TABLES) {
      expect(tableExists(db, table), `tabela ${table} deveria sumir após down`).toBe(false);
    }

    // demands (baseline) permanece intacta — rollback é cirúrgico.
    expect(tableExists(db, 'demands')).toBe(true);
  });

  it('a up migration é idempotente (CREATE TABLE IF NOT EXISTS)', () => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE demands (id INTEGER PRIMARY KEY AUTOINCREMENT);');
    const upSql = readFileSync(UP, 'utf-8');
    db.exec(upSql);
    expect(() => db!.exec(upSql)).not.toThrow();
  });
});
