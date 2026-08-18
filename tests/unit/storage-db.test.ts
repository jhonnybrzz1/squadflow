import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Mock server/db
vi.mock('../../server/db', async () => {
  const Database = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schemaSqlite = await import('../../shared/schema');
  const sqlite = new Database.default(':memory:');
  const drizzleDb = drizzle(sqlite, { schema: schemaSqlite });
  const run = async (query: any) => sqlite.exec(query.sql);
  const all = async (query: any) => sqlite.prepare(query.sql).all();
  const get = async (query: any) => sqlite.prepare(query.sql).get();

  return {
    db: Object.assign(drizzleDb, {
      run,
      execute: run,
      all,
      get,
      $client: sqlite,
    }),
    isPostgres: false,
    dbHelper: {
      isPostgres: false,
      run,
      all,
      get,
    },
    // CRIT-11: deleteDemand/clearDemands agora rodam dentro de dbTransaction.
    // Para o teste de unidade (sqlite :memory:), basta encaminhar o callback
    // para a mesma instância drizzle — a atomicidade real é exercitada pelos
    // testes de integração de `dbTransaction` em server/db.ts.
    dbTransaction: async (callback: (tx: typeof drizzleDb) => Promise<unknown>) =>
      callback(drizzleDb),
  };
});

import { DbStorage } from '../../server/storage-db';
import { db } from '../../server/db';

describe('DbStorage (Unit Test with Mock DB)', () => {
  it('deve inicializar o schema e realizar operações básicas', async () => {
    // Get the sqlite instance from drizzle
    const sqlite = (db as any).$client;

    const schemaPath = path.resolve(__dirname, '../fixtures/schema-sqlite-init.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    const statements = schemaSql.split('--> statement-breakpoint');
    for (const stmt of statements) {
      if (stmt.trim()) {
        try {
          sqlite.exec(stmt);
        } catch (e) {
          if (!(e as Error).message.includes('already exists')) throw e;
        }
      }
    }

    const storage = new DbStorage();

    // Test User
    const user = await storage.createUser({
      username: 'unit_test_user',
      password: 'password',
    });
    expect(user.id).toBeGreaterThan(0);

    // Test Demand
    const demand = await storage.createDemand({
      title: 'Unit Test Demand',
      description: 'Testing',
      type: 'feature',
      priority: 'high',
    });
    expect(demand.id).toBeGreaterThan(0);
    expect(demand.status).toBe('processing');

    // Test Update
    await storage.updateDemand(demand.id, { status: 'completed' });
    const updated = await storage.getDemand(demand.id);
    expect(updated?.status).toBe('completed');

    // Test Chat
    const messages = [{ role: 'user', content: 'Hello' }] as any;
    await storage.updateDemandChat(demand.id, messages);
    const withChat = await storage.getDemand(demand.id);
    expect(withChat?.chatMessages).toEqual(messages);
  });
});
