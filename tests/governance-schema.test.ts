import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { governanceSqliteStatements } from '../server/services/governance-schema';

describe('SQLite governance schema bootstrap', () => {
  it('creates the governance tables idempotently without requiring a demands table', () => {
    const sqlite = new Database(':memory:');

    for (const statement of governanceSqliteStatements) sqlite.exec(statement);
    for (const statement of governanceSqliteStatements) sqlite.exec(statement);

    sqlite
      .prepare(
        `INSERT INTO approval_comments
          (demand_id, author, content, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(1, 'local-user', 'Comentário preservado', Date.now());

    const tables = sqlite
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('document_snapshots', 'approval_comments', 'document_lifecycle_events')
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const comment = sqlite
      .prepare('SELECT demand_id, author, content FROM approval_comments WHERE demand_id = 1')
      .get();

    expect(tables.map((row) => row.name)).toEqual([
      'approval_comments',
      'document_lifecycle_events',
      'document_snapshots',
    ]);
    expect(comment).toEqual({
      demand_id: 1,
      author: 'local-user',
      content: 'Comentário preservado',
    });

    sqlite.close();
  });
});
