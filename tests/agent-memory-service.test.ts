/**
 * Demanda 10088 (item 4) — agent_memory insert-only + leitura paginada.
 * SQLite real (`:memory:`), sem mockar o banco que esta feature introduz.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import {
  agentMemoryService,
  __setAgentMemoryRunnerForTests,
} from '../server/services/agent-memory-service';

function makeRunner(sqlite: Database.Database) {
  const db = drizzle(sqlite);
  return {
    run: (q: ReturnType<typeof sql>) => db.run(q),
    all: <T>(q: ReturnType<typeof sql>) => db.all(q) as T[],
  };
}

afterEach(() => __setAgentMemoryRunnerForTests(null));

describe('AgentMemoryService', () => {
  it('cria schema idempotentemente e registra (insert-only)', async () => {
    const sqlite = new Database(':memory:');
    __setAgentMemoryRunnerForTests(makeRunner(sqlite));
    await agentMemoryService.ensureSchema();
    await agentMemoryService.ensureSchema(); // idempotente

    await agentMemoryService.record({
      agentId: 'scrum_master',
      memoryType: 'sm_session',
      content: 'a',
    });
    const { id } = await agentMemoryService.record({
      agentId: 'scrum_master',
      memoryType: 'sm_session',
      content: 'b',
      sourceDemandId: 42,
    });
    expect(id).toBeTruthy();
    const all = await agentMemoryService.list();
    expect(all).toHaveLength(2);
    expect(all[0].sourceDemandId).toBe(42); // mais recente primeiro (created_at DESC)
  });

  it('filtra por memory_type e source_demand_id, e pagina', async () => {
    const sqlite = new Database(':memory:');
    __setAgentMemoryRunnerForTests(makeRunner(sqlite));
    for (let i = 0; i < 5; i++) {
      await agentMemoryService.record({ agentId: 'qa', memoryType: 'qa_note', content: `n${i}` });
    }
    await agentMemoryService.record({
      agentId: 'sm',
      memoryType: 'sm_session',
      content: 'x',
      sourceDemandId: 7,
    });

    expect(await agentMemoryService.list({ memoryType: 'sm_session' })).toHaveLength(1);
    expect(await agentMemoryService.list({ sourceDemandId: 7 })).toHaveLength(1);
    expect(await agentMemoryService.list({ memoryType: 'qa_note' })).toHaveLength(5);
    // paginação
    expect(await agentMemoryService.list({ memoryType: 'qa_note', limit: 2 })).toHaveLength(2);
    expect(
      await agentMemoryService.list({ memoryType: 'qa_note', limit: 2, offset: 4 }),
    ).toHaveLength(1);
  });

  it('remove registros mais antigos que o TTL (Spec 10126 T4)', async () => {
    const sqlite = new Database(':memory:');
    __setAgentMemoryRunnerForTests(makeRunner(sqlite));

    // Insere um registro antigo manualmente com created_at de 100 dias atrás
    await agentMemoryService.ensureSchema();
    sqlite.exec(
      `INSERT INTO agent_memory (id, agent_id, memory_type, content, source_demand_id, created_at)
       VALUES ('old-1', 'qa', 'qa_note', 'old', 1, datetime('now', '-100 days'))`,
    );
    await agentMemoryService.record({ agentId: 'qa', memoryType: 'qa_note', content: 'recent' });

    expect(await agentMemoryService.list()).toHaveLength(2);
    await agentMemoryService.cleanup(90);
    const remaining = await agentMemoryService.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe('recent');
  });

  it('rejects invalid TTL values without executing DELETE (Spec 10187)', async () => {
    const sqlite = new Database(':memory:');
    __setAgentMemoryRunnerForTests(makeRunner(sqlite));
    await agentMemoryService.ensureSchema();
    await agentMemoryService.record({ agentId: 'qa', memoryType: 'qa_note', content: 'recent' });

    // TTL 0 is treated as "disable cleanup" (see dedicated test below), not invalid.
    const invalidValues = [null as any, NaN, -1, 0.5, Infinity, '3600' as any];
    for (const ttl of invalidValues) {
      const before = await agentMemoryService.list();
      const result = await agentMemoryService.cleanup(ttl);
      const after = await agentMemoryService.list();
      expect(after).toHaveLength(before.length);
      expect(result.deleted).toBe(0);
    }
  });

  it('executes DELETE with valid TTL including large integer (Spec 10187)', async () => {
    const sqlite = new Database(':memory:');
    __setAgentMemoryRunnerForTests(makeRunner(sqlite));
    await agentMemoryService.ensureSchema();
    sqlite.exec(
      `INSERT INTO agent_memory (id, agent_id, memory_type, content, source_demand_id, created_at)
       VALUES ('old-1', 'qa', 'qa_note', 'old', 1, datetime('now', '-100 days'))`,
    );
    await agentMemoryService.record({ agentId: 'qa', memoryType: 'qa_note', content: 'recent' });

    await agentMemoryService.cleanup(90);
    expect(await agentMemoryService.list()).toHaveLength(1);

    const largeTtl = 2 ** 31 - 1;
    const result = await agentMemoryService.cleanup(largeTtl);
    expect(result.deleted).toBe(0); // no records older than ~68 years
  });

  it('desabilita cleanup quando TTL é 0 (Spec 10126 T4)', async () => {
    const sqlite = new Database(':memory:');
    __setAgentMemoryRunnerForTests(makeRunner(sqlite));
    await agentMemoryService.ensureSchema();
    sqlite.exec(
      `INSERT INTO agent_memory (id, agent_id, memory_type, content, source_demand_id, created_at)
       VALUES ('old-1', 'qa', 'qa_note', 'old', 1, datetime('now', '-100 days'))`,
    );
    await agentMemoryService.record({ agentId: 'qa', memoryType: 'qa_note', content: 'recent' });

    await agentMemoryService.cleanup(0);
    expect(await agentMemoryService.list()).toHaveLength(2);
  });
});
