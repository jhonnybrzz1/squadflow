import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(
  new URL('../../migrations/0033_refinement_item_feedback.sql', import.meta.url),
);
const migrationSql = readFileSync(migrationPath, 'utf8');
const databases: Database.Database[] = [];

function createDatabase(): Database.Database {
  const database = new Database(':memory:');
  databases.push(database);
  return database;
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe('refinement item feedback SQLite migration', () => {
  it('creates the evolved table when the legacy table never existed', () => {
    const database = createDatabase();
    database.exec(migrationSql);

    const columns = database.prepare('PRAGMA table_info(feedback_refinamento)').all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['item_index', 'item_key', 'version_hash', 'status', 'atualizado_em']),
    );
  });

  it('preserves legacy ratings and updates one row when an item status changes', () => {
    const database = createDatabase();
    database.exec(`
      CREATE TABLE feedback_refinamento (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        refinement_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        nota INTEGER NOT NULL,
        texto TEXT,
        modelo TEXT,
        qtd_iteracoes_ate_feedback INTEGER,
        criado_em INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO feedback_refinamento (refinement_id, agent_id, nota, texto)
      VALUES ('legacy:qa', 'qa', 5, 'preservar');
    `);

    database.exec(migrationSql);
    const legacy = database
      .prepare('SELECT nota, texto FROM feedback_refinamento WHERE refinement_id = ?')
      .get('legacy:qa') as { nota: number; texto: string };
    expect(legacy).toEqual({ nota: 5, texto: 'preservar' });

    const upsert = database.prepare(`
      INSERT INTO feedback_refinamento (
        refinement_id, agent_id, item_index, item_key, version_hash, status
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(refinement_id, version_hash, item_key) DO UPDATE SET
        status = excluded.status,
        atualizado_em = unixepoch()
    `);
    upsert.run('message-1', 'qa', 0, 'item-a', 'version-a', 'feito');
    upsert.run('message-1', 'qa', 0, 'item-a', 'version-a', 'desatualizado');

    const rows = database
      .prepare('SELECT id, status FROM feedback_refinamento WHERE refinement_id = ?')
      .all('message-1') as Array<{ id: number; status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('desatualizado');
  });
});
