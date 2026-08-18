/**
 * Regressão de segurança: `queryLogs()` construía WHERE por concatenação de
 * string com um escape ingênuo (`replace(/'/g, "''")`), flagado como SQL
 * injection em múltiplas auditorias (2026-07-21). O fix trocou para `sql``
 * parametrizado. Este teste roda contra SQLite REAL (não mocka o banco) para
 * provar que um payload clássico de injection não altera o resultado —
 * inspecionar apenas os args do mock não provaria isso.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

let sqlite: Database.Database;

vi.mock('../server/services/audit-loss-tracker', () => ({
  recordAuditLoss: vi.fn(),
  getAuditLossState: vi.fn(() => ({ degraded: false, totalLosses: 0, lastSink: null })),
  resetAuditLossState: vi.fn(),
}));

vi.mock('../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../server/db', () => ({
  isPostgres: false,
  db: {},
  dbHelper: {
    run: (q: SQL) => {
      drizzle(sqlite).run(q);
    },
    all: (q: SQL) => drizzle(sqlite).all(q),
    get: (q: SQL) => {
      const rows = drizzle(sqlite).all(q) as unknown[];
      return rows[0];
    },
  },
}));

afterEach(() => {
  sqlite?.close();
  vi.resetModules();
});

describe('llm-audit-log queryLogs — SQL injection regression', () => {
  it('payload clássico em userId não retorna linhas de outros usuários (bind param real)', async () => {
    sqlite = new Database(':memory:');
    const { llmAuditLogService } = await import('../server/services/llm-audit-log');

    const makeEntry = (
      overrides: Partial<import('../server/services/llm-audit-log').LlmAuditLogEntry>,
    ): import('../server/services/llm-audit-log').LlmAuditLogEntry => ({
      requestId: 'req-1',
      prompt: 'p',
      response: 'r',
      model: 'm',
      provider: 'p',
      latencyMs: 1,
      statusCode: 200,
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      ...overrides,
    });

    llmAuditLogService.record(makeEntry({ requestId: 'req-1', userId: 'alice' }));
    llmAuditLogService.record(makeEntry({ requestId: 'req-2', userId: 'bob' }));
    await new Promise((r) => setTimeout(r, 100));

    // payload que, se concatenado sem escape correto, forçaria a condição a
    // ser sempre verdadeira e vazar linhas de outros usuários.
    const injection = "nobody' OR '1'='1";
    const result = await llmAuditLogService.queryLogs({ userId: injection });

    expect(result.logs).toHaveLength(0);
    expect(result.total).toBe(0);

    // sanity check: filtro legítimo ainda funciona (prova que não quebrou a query)
    const legit = await llmAuditLogService.queryLogs({ userId: 'alice' });
    expect(legit.total).toBe(1);
    expect(legit.logs[0]?.userId).toBe('alice');

    llmAuditLogService.destroy();
  });
});
