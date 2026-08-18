/**
 * Spec 10192 — Fixture shadow: compara payload de GET /demands
 * (findAll/findById) com listWithRelations, garantindo deep equal
 * e provando que a nova camada de relations não altera contrato.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schemaSqlite from '../../shared/schema';

const sqlite = new Database(':memory:');
const drizzleDb = drizzle(sqlite, { schema: schemaSqlite });

const { demandRepository } = await (async () => {
  const run = (query: { sql: string }) => sqlite.exec(query.sql);
  vi.doMock('../../server/db', () => ({
    db: Object.assign(drizzleDb, {
      run,
      execute: run,
      all: <T>(query: { sql: string }) => sqlite.prepare(query.sql).all() as T[],
      get: <T>(query: { sql: string }) => sqlite.prepare(query.sql).get() as T | undefined,
      $client: sqlite,
    }),
    isPostgres: false,
    getDb: () => drizzleDb,
    dbTransaction: async (callback: (tx: typeof drizzleDb) => Promise<unknown>) =>
      callback(drizzleDb),
    dbHelper: {
      isPostgres: false,
      run,
      all: <T>(query: { sql: string }) => sqlite.prepare(query.sql).all() as T[],
      get: <T>(query: { sql: string }) => sqlite.prepare(query.sql).get() as T | undefined,
    },
  }));
  vi.doMock('../../server/utils/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }));
  vi.doMock('../../server/storage', async () => {
    const { DbStorage } = await import('../../server/storage-db');
    return { storage: new DbStorage(), IStorage: (await import('../../server/storage')).IStorage };
  });
  const repo = await import('../../server/repositories/demand-repository');
  return repo;
})();

const { toDemandListItems } = await import('../../server/routes/demand-presenter');
const { toRestSafeDemand } = await import('../../server/routes/shared');

describe('DemandRepository.listWithRelations fixture shadow', () => {
  beforeAll(() => {
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
  });

  afterAll(() => {
    sqlite.close();
  });

  it('GET /api/demands payload: findAll and listWithRelations are deep equal (ignoring files field)', async () => {
    // 1. Create demand directly via repository (same path used by POST /api/demands)
    await demandRepository.create(
      {
        title: 'Demanda shadow',
        description: 'descrição',
        type: 'nova_funcionalidade',
        priority: 'media',
        domain: 'padrao',
      },
      {
        files: [
          {
            filename: 'doc.md',
            originalName: 'doc.md',
            mimeType: 'text/markdown',
            size: 12,
            path: '/tmp/doc.md',
            demandId: null,
          },
        ],
      },
    );

    // 2. Current implementation (findAll) used by GET /api/demands
    const findAllResult = await demandRepository.findAll();
    const findAllList = toDemandListItems(findAllResult);

    // 3. New implementation (listWithRelations)
    const listWithRelationsResult = await demandRepository.listWithRelations();
    const listWithRelationsList = toDemandListItems(
      listWithRelationsResult.map(({ files: _files, ...demand }) => demand),
    );

    // 4. Deep equal on the same projection used by GET /api/demands
    expect(listWithRelationsList).toEqual(findAllList);

    // 5. listWithRelations also exposes files (new capability)
    const withFiles = listWithRelationsResult[0] as DemandWithFiles;
    expect(withFiles.files).toHaveLength(1);
    expect(withFiles.files[0].filename).toBe('doc.md');
  });

  it('GET /api/demands/:id payload: findById and listWithRelations item are deep equal', async () => {
    const created = await demandRepository.create(
      {
        title: 'Demanda shadow single',
        description: 'descrição',
        type: 'melhoria',
        priority: 'baixa',
      },
      {
        files: [
          {
            filename: 'a.txt',
            originalName: 'a.txt',
            mimeType: 'text/plain',
            size: 1,
            path: '/tmp/a.txt',
            demandId: null,
          },
        ],
      },
    );

    const byId = await demandRepository.findByIdOrNull(created.id);
    const byList = (await demandRepository.listWithRelations()).find((d) => d.id === created.id);

    // same REST-safe projection (strip files extra field from listWithRelations)
    const { files, ...listWithoutFiles } = byList!;
    expect(files).toBeDefined();
    expect(toRestSafeDemand(byId!)).toEqual(toRestSafeDemand(listWithoutFiles as DemandWithFiles));
  });
});
