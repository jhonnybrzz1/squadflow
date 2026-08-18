/**
 * Demanda 10094 — guardrails da memória episódica.
 * SQLite real (`:memory:`): a feature introduz o schema, não faz sentido mocká-lo.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../server/db', () => ({
  dbHelper: { run: vi.fn(), all: vi.fn(() => []) },
  isPostgres: false,
}));

import {
  episodicMemoryStore,
  __setEpisodicRunnerForTests,
  isPromotable,
  MIN_CONFIDENCE_FOR_INJECTION,
} from '../server/services/episodic-memory-store';

function makeRunner(sqlite: Database.Database) {
  const db = drizzle(sqlite);
  return {
    run: (q: ReturnType<typeof sql>) => db.run(q),
    all: <T>(q: ReturnType<typeof sql>) => db.all(q) as T[],
  };
}

afterEach(() => __setEpisodicRunnerForTests(null));

describe('isPromotable — as três condições do PRD', () => {
  const ok = { confidence: 0.7, sanitized: true, sourceType: 'episodic' };
  it('aceita no limiar exato de confiança', () => {
    expect(isPromotable(ok)).toBe(true);
    expect(MIN_CONFIDENCE_FOR_INJECTION).toBe(0.7);
  });
  it('rejeita confiança abaixo do limiar', () => {
    expect(isPromotable({ ...ok, confidence: 0.69 })).toBe(false);
  });
  it('rejeita não sanitizado, mesmo com confiança alta', () => {
    expect(isPromotable({ ...ok, confidence: 0.99, sanitized: false })).toBe(false);
  });
  it('rejeita origem diferente de episodic', () => {
    expect(isPromotable({ ...ok, sourceType: 'manual' })).toBe(false);
  });
});

describe('EpisodicMemoryStore', () => {
  it('sanitiza na ESCRITA — não existe caminho para gravar conteúdo cru', async () => {
    const sqlite = new Database(':memory:');
    __setEpisodicRunnerForTests(makeRunner(sqlite));

    const { masked } = await episodicMemoryStore.record({
      skill: 'debugging',
      content: 'erro no cartao 4111 1111 1111 1111 do cliente',
      confidence: 0.9,
    });
    expect(masked).toBe(true);

    const [ep] = await episodicMemoryStore.listBySkill('debugging');
    expect(ep.content).not.toContain('4111 1111 1111 1111');
    expect(ep.sanitized).toBe(true);
    expect(ep.sourceType).toBe('episodic');
  });

  it('injeção só devolve padrões acima do limiar', async () => {
    const sqlite = new Database(':memory:');
    __setEpisodicRunnerForTests(makeRunner(sqlite));

    await episodicMemoryStore.record({ skill: 'debugging', content: 'forte', confidence: 0.85 });
    await episodicMemoryStore.record({ skill: 'debugging', content: 'fraco', confidence: 0.5 });

    const injectable = await episodicMemoryStore.getInjectablePatterns('debugging');
    expect(injectable).toHaveLength(1);
    expect(injectable[0].content).toBe('forte');
  });

  it('padrão não sanitizado gravado por fora NÃO passa pelo ponto de injeção', async () => {
    const sqlite = new Database(':memory:');
    __setEpisodicRunnerForTests(makeRunner(sqlite));
    await episodicMemoryStore.ensureSchema();

    // Simula um caminho alternativo (import/bug) que grava sanitized=0.
    sqlite
      .prepare(
        `INSERT INTO episodic_memory (id, skill, content, confidence, sanitized, source_type)
         VALUES ('x','debugging','vazamento cru',0.99,0,'episodic')`,
      )
      .run();

    expect(await episodicMemoryStore.getInjectablePatterns('debugging')).toHaveLength(0);
  });

  it('retryComparison: sem os dois lados, não inventa variação', async () => {
    const sqlite = new Database(':memory:');
    __setEpisodicRunnerForTests(makeRunner(sqlite));

    await episodicMemoryStore.record({
      skill: 'debugging',
      content: 'a',
      retryCount: 4,
      memoryActive: false,
    });
    const onlyBaseline = await episodicMemoryStore.retryComparison('debugging');
    expect(onlyBaseline.baseline.avgRetry).toBe(4);
    expect(onlyBaseline.withMemory.avgRetry).toBeNull();
    expect(onlyBaseline.reductionPercent).toBeNull();

    await episodicMemoryStore.record({
      skill: 'debugging',
      content: 'b',
      retryCount: 2,
      memoryActive: true,
    });
    const both = await episodicMemoryStore.retryComparison('debugging');
    expect(both.reductionPercent).toBe(50); // 4 -> 2
  });
});
