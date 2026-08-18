import { describe, it, expect, vi } from 'vitest';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../shared/schema';
import { dlqSqliteStatements } from '../../server/services/dlq-schema';

const createTestDb = () => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  return { sqlite, db: drizzle(sqlite, { schema }) };
};

describe('Bug 10270: dead-letter service cleanup', () => {
  it('cleanupOlderThan retorna 0 sem crashar quando dead_letters não existe', async () => {
    const { db } = createTestDb();

    // Substitui o db importado do módulo por uma instância em memória sem tabelas
    vi.doMock('../../server/db', () => ({ db }));
    const { DeadLetterService: DLS } = await import('../../server/services/dead-letter-service');

    const service = new DLS();
    const removed = await service.cleanupOlderThan(30);
    expect(removed).toBe(0);
  });

  it('ensureDlqSchema cria as 3 tabelas no SQLite', () => {
    const { sqlite } = createTestDb();
    for (const stmt of dlqSqliteStatements) {
      sqlite.exec(stmt);
    }

    const tables = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('dead_letters', 'dlq_messages', 'agent_failures')",
      )
      .all() as { name: string }[];

    expect(tables.map((t) => t.name).sort()).toEqual([
      'agent_failures',
      'dead_letters',
      'dlq_messages',
    ]);
  });
});
