import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { dropDemandModeColumnIfExists } from '../../server/db/migrations';

describe('dropDemandModeColumnIfExists (Spec 10146)', () => {
  it('remove mode, preserva colunas/dados/PK e mantém FKs filhas válidas', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE demands (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          title TEXT NOT NULL DEFAULT 'x',
          description TEXT,
          mode TEXT,
          status TEXT DEFAULT 'draft'
        )
      `);
      sqlite.exec(`CREATE INDEX idx_demands_status ON demands(status)`);
      sqlite.exec(`CREATE INDEX idx_demands_mode ON demands(mode)`);

      sqlite.exec(`
        CREATE TABLE artifacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          demand_id INTEGER NOT NULL,
          name TEXT,
          FOREIGN KEY (demand_id) REFERENCES demands(id)
        )
      `);
      sqlite.exec(`CREATE INDEX idx_artifacts_demand_id ON artifacts(demand_id)`);

      sqlite.exec(
        "INSERT INTO demands (title, description, mode, status) VALUES ('t1', 'd1', 'auto', 'draft')",
      );
      sqlite.exec("INSERT INTO demands (title, status) VALUES ('t2', 'pending')");
      sqlite.exec("INSERT INTO artifacts (demand_id, name) VALUES (1, 'a1')");

      dropDemandModeColumnIfExists(sqlite);

      const columns = sqlite
        .prepare("SELECT name FROM pragma_table_info('demands')")
        .all() as Array<{ name: string }>;
      const columnNames = columns.map((c) => c.name);
      expect(columnNames).toContain('id');
      expect(columnNames).toContain('title');
      expect(columnNames).toContain('description');
      expect(columnNames).toContain('status');
      expect(columnNames).not.toContain('mode');

      const rows = sqlite
        .prepare('SELECT id, title, description, status FROM demands ORDER BY id')
        .all() as Array<{ id: number; title: string; description: string | null; status: string }>;
      expect(rows).toEqual([
        { id: 1, title: 't1', description: 'd1', status: 'draft' },
        { id: 2, title: 't2', description: null, status: 'pending' },
      ]);

      const pk = sqlite
        .prepare("SELECT name FROM pragma_table_info('demands') WHERE pk > 0")
        .all() as Array<{ name: string }>;
      expect(pk.map((c) => c.name)).toEqual(['id']);

      const indexes = sqlite
        .prepare("SELECT name FROM pragma_index_list('demands')")
        .all() as Array<{ name: string }>;
      const indexNames = indexes
        .map((i) => i.name)
        .filter((n) => !n.startsWith('sqlite_autoindex_'));
      expect(indexNames).toContain('idx_demands_status');
      expect(indexNames).not.toContain('idx_demands_mode');

      // FK filha ainda funciona
      expect(() =>
        sqlite.exec("INSERT INTO artifacts (demand_id, name) VALUES (1, 'a2')"),
      ).not.toThrow();
      expect(() =>
        sqlite.exec("INSERT INTO artifacts (demand_id, name) VALUES (999, 'a3')"),
      ).toThrow();
    } finally {
      sqlite.close();
    }
  });

  it('é idempotente quando mode já foi removido', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE demands (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          title TEXT
        )
      `);
      sqlite.exec("INSERT INTO demands (title) VALUES ('t1')");

      dropDemandModeColumnIfExists(sqlite);

      const rows = sqlite.prepare('SELECT * FROM demands').all() as Array<{
        id: number;
        title: string;
      }>;
      expect(rows).toEqual([{ id: 1, title: 't1' }]);
    } finally {
      sqlite.close();
    }
  });
});
