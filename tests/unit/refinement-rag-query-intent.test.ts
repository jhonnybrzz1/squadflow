/**
 * Auditoria 2026-07-21: query-intent.ts (detecção de intenção + parâmetros de
 * retrieval sugeridos, incluindo useReranking) não tinha NENHUM importador
 * fora do próprio arquivo — a decisão de reranking por tipo de query nunca
 * chegava na pipeline real; retrieveHybrid() sempre ligava rerank
 * incondicionalmente. Estes testes provam a conexão real, atrás da flag
 * enableQueryIntentDetection (default OFF — flag off preserva o
 * comportamento anterior).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flagsState = vi.hoisted(() => ({ enableQueryIntentDetection: false }));

vi.mock('../../server/services/feature-flags', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../server/services/feature-flags')>();
  return {
    ...original,
    featureFlags: {
      ...original.featureFlags,
      getFlags: () => ({ ...original.featureFlags.getFlags(), ...flagsState }),
    },
  };
});

vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: { findAll: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../../server/services/embedding-service', () => ({
  embeddingService: {
    getEmbedding: vi.fn().mockRejectedValue(new Error('disabled in test')),
    getEmbeddings: vi.fn().mockResolvedValue([]),
    serializeEmbedding: vi.fn().mockReturnValue('[]'),
    deserializeEmbedding: vi.fn().mockReturnValue([]),
    cosineSimilarity: vi.fn().mockReturnValue(0),
  },
}));

import { RefinementRAGService } from '../../server/services/refinement-rag';
import { RetrievalService } from '../../server/services/retrieval-service';
import type { DbClient } from '../../server/db';

describe('refinement-rag — conexão real do query-intent no retrieveHybrid', () => {
  let sqliteDb: Database.Database | null = null;
  let retrieveSpy: ReturnType<typeof vi.spyOn>;

  function makeService(): RefinementRAGService {
    const sqlite = new Database(':memory:');
    sqliteDb = sqlite;
    const db = drizzle(sqlite);
    return new RefinementRAGService(db as unknown as DbClient);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    flagsState.enableQueryIntentDetection = false;
    retrieveSpy = vi
      .spyOn(RetrievalService.prototype, 'retrieve')
      .mockResolvedValue([]) as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    sqliteDb?.close();
    sqliteDb = null;
  });

  it('flag OFF (default): useReranking sempre true, igual ao comportamento anterior', async () => {
    const service = makeService();
    // Query "general" (sem keyword de nenhuma categoria) — com a flag ligada,
    // isso desligaria o rerank; com a flag off, deve permanecer true.
    await service.retrieveHybrid('texto qualquer sem padrão reconhecido', 4, {});

    const policy = retrieveSpy.mock.calls[0][1] as { useReranking?: boolean };
    expect(policy.useReranking).toBe(true);
  });

  it('flag ON: query "general" desliga o rerank (economia de custo)', async () => {
    flagsState.enableQueryIntentDetection = true;
    const service = makeService();
    await service.retrieveHybrid('texto qualquer sem padrão reconhecido', 4, {});

    const policy = retrieveSpy.mock.calls[0][1] as { useReranking?: boolean };
    expect(policy.useReranking).toBe(false);
  });

  it('flag ON: query regulatória mantém o rerank ligado', async () => {
    flagsState.enableQueryIntentDetection = true;
    const service = makeService();
    await service.retrieveHybrid('qual o prazo da resolução normativa de compliance?', 4, {});

    const policy = retrieveSpy.mock.calls[0][1] as { useReranking?: boolean };
    expect(policy.useReranking).toBe(true);
  });
});
