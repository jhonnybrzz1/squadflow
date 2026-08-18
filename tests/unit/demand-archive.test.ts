/**
 * MÉDIO-04 — snapshot mínimo retido no delete da demanda.
 *
 * Roda contra SQLite REAL em memória (não mock de linhas) porque o ponto do
 * teste é o schema e o SQL de agregação de custo — ver a memória "Testes mockam
 * o banco: cegueira a schema".
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@shared/schema';

vi.mock('../../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  DEMAND_ARCHIVE_CREATE_STATEMENTS,
  demandArchiveService,
  __setDemandArchiveRunnerForTests,
  type DemandArchiveDbRunner,
} from '../../server/services/demand-archive';

function makeRunner(sqlite: Database.Database): DemandArchiveDbRunner {
  const db = drizzle(sqlite, { schema });
  return {
    run: (q) => db.run(q),
    all: <T>(q: ReturnType<typeof sql>) => db.all(q) as T[],
  };
}

let sqlite: Database.Database;

beforeEach(() => {
  sqlite = new Database(':memory:');
  // A trilha que sobrevive ao delete — é dela que sai o custo congelado.
  sqlite.exec(`CREATE TABLE llm_audit_logs (
    id INTEGER PRIMARY KEY,
    demand_id INTEGER,
    total_tokens INTEGER,
    estimated_cost_usd REAL
  )`);
  __setDemandArchiveRunnerForTests(makeRunner(sqlite));
});

afterEach(() => {
  __setDemandArchiveRunnerForTests(null);
  sqlite.close();
});

describe('DemandArchiveService', () => {
  it('cria a tabela idempotentemente', () => {
    for (const s of DEMAND_ARCHIVE_CREATE_STATEMENTS) sqlite.exec(s);
    for (const s of DEMAND_ARCHIVE_CREATE_STATEMENTS) sqlite.exec(s);

    const cols = (
      sqlite.prepare("PRAGMA table_info('demand_archive')").all() as Array<{ name: string }>
    ).map((c) => c.name);

    expect(cols).toEqual(
      expect.arrayContaining([
        'demand_id',
        'title',
        'final_status',
        'quality_gate_status',
        'requires_human_review',
        'llm_calls',
        'total_tokens',
        'cost_usd',
        'archived_at',
      ]),
    );
  });

  it('congela o custo acumulado da demanda no momento do arquivamento', async () => {
    sqlite
      .prepare(
        'INSERT INTO llm_audit_logs (demand_id, total_tokens, estimated_cost_usd) VALUES (?,?,?)',
      )
      .run(42, 1000, 0.5);
    sqlite
      .prepare(
        'INSERT INTO llm_audit_logs (demand_id, total_tokens, estimated_cost_usd) VALUES (?,?,?)',
      )
      .run(42, 500, 0.25);
    // Chamada de OUTRA demanda não pode entrar na conta.
    sqlite
      .prepare(
        'INSERT INTO llm_audit_logs (demand_id, total_tokens, estimated_cost_usd) VALUES (?,?,?)',
      )
      .run(99, 9999, 9.99);

    await demandArchiveService.archive({
      demandId: 42,
      title: 'Demanda útil',
      type: 'melhoria',
      finalStatus: 'completed',
      qualityGateStatus: 'passed',
      requiresHumanReview: false,
    });

    const record = await demandArchiveService.findById(42);
    expect(record).toMatchObject({
      demandId: 42,
      title: 'Demanda útil',
      finalStatus: 'completed',
      qualityGateStatus: 'passed',
      requiresHumanReview: false,
      llmCalls: 2,
      totalTokens: 1500,
    });
    expect(record?.costUsd).toBeCloseTo(0.75, 6);
  });

  it('é idempotente por demanda (não duplica nem sobrescreve)', async () => {
    await demandArchiveService.archive({ demandId: 7, title: 'primeiro' });
    await demandArchiveService.archive({ demandId: 7, title: 'segundo' });

    const rows = sqlite.prepare('SELECT * FROM demand_archive WHERE demand_id = 7').all();
    expect(rows).toHaveLength(1);
    expect((rows[0] as { title: string }).title).toBe('primeiro');
  });

  it('demanda sem trilha LLM arquiva com custo zero, não falha', async () => {
    await demandArchiveService.archive({ demandId: 500, title: 'sem custo' });

    const record = await demandArchiveService.findById(500);
    expect(record).toMatchObject({ demandId: 500, llmCalls: 0, totalTokens: 0, costUsd: 0 });
  });

  // O arquivamento é best-effort: nunca pode impedir o usuário de apagar.
  it('não lança quando o banco falha', async () => {
    __setDemandArchiveRunnerForTests({
      run: () => {
        throw new Error('db down');
      },
      all: () => {
        throw new Error('db down');
      },
    });

    await expect(demandArchiveService.archive({ demandId: 1 })).resolves.toBeUndefined();
  });
});
