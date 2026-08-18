/**
 * Spec 029 — Ruído de RAG nos refinamentos.
 *
 * Garante as três barreiras contra o ruído que fazia agentes citarem
 * demandas históricas (ex.: "Demanda 10059") como se fossem a atual:
 *
 * 1. Piso de relevância (`minSimilarity`) sempre passado ao RetrievalService,
 *    com env `REFINEMENT_RAG_MIN_SIMILARITY` fail-safe (default 0.25).
 * 2. Conteúdo indexado de chats sem o prefixo citável `Demanda {id}:`.
 * 3. Header do guardrail instruindo que documentos recuperados são
 *    histórico de outras demandas.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/repositories/demand-repository', () => ({
  demandRepository: {
    findAll: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../server/services/embedding-service', () => ({
  embeddingService: {
    getEmbedding: vi.fn().mockRejectedValue(new Error('disabled in test')),
    getEmbeddings: vi.fn().mockResolvedValue([]),
    serializeEmbedding: vi.fn().mockReturnValue('[]'),
    deserializeEmbedding: vi.fn().mockReturnValue([]),
    cosineSimilarity: vi.fn().mockReturnValue(0),
  },
}));

import { RefinementRAGService } from '../server/services/refinement-rag';
import { RetrievalService } from '../server/services/retrieval-service';
import { formatRetrievedAsData } from '../server/services/retrieval-guardrail';
import type { DbClient } from '../server/db';

const ENV_KEY = 'REFINEMENT_RAG_MIN_SIMILARITY';

describe('Spec 029 — piso de relevância no RAG de refinamentos', () => {
  let sqliteDb: Database.Database | null = null;
  let retrieveSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = process.env[ENV_KEY];

  function makeService(): RefinementRAGService {
    const sqlite = new Database(':memory:');
    sqliteDb = sqlite;
    const db = drizzle(sqlite);
    return new RefinementRAGService(db as unknown as DbClient);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env[ENV_KEY];
    retrieveSpy = vi
      .spyOn(RetrievalService.prototype, 'retrieve')
      .mockResolvedValue([]) as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    retrieveSpy.mockRestore();
    sqliteDb?.close();
    sqliteDb = null;
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalEnv;
    }
  });

  it('retrieve() passa minSimilarity default 0.25 quando a env não está setada', async () => {
    const service = makeService();
    await service.retrieve('query qualquer', 4, {});
    expect(retrieveSpy).toHaveBeenCalledTimes(1);
    const policy = retrieveSpy.mock.calls[0][1] as { minSimilarity?: number };
    expect(policy.minSimilarity).toBe(0.25);
  });

  it('retrieveHybrid() também passa o piso (mesmo caminho com rerank)', async () => {
    const service = makeService();
    await service.retrieveHybrid('query qualquer', 4, {});
    expect(retrieveSpy).toHaveBeenCalledTimes(1);
    const policy = retrieveSpy.mock.calls[0][1] as { minSimilarity?: number };
    expect(policy.minSimilarity).toBe(0.25);
  });

  it('respeita valor válido da env (0.4)', async () => {
    process.env[ENV_KEY] = '0.4';
    const service = makeService();
    await service.retrieve('q', 4, {});
    const policy = retrieveSpy.mock.calls[0][1] as { minSimilarity?: number };
    expect(policy.minSimilarity).toBe(0.4);
  });

  it('0 é kill switch legítimo (desliga o piso, não cai no default)', async () => {
    process.env[ENV_KEY] = '0';
    const service = makeService();
    await service.retrieve('q', 4, {});
    const policy = retrieveSpy.mock.calls[0][1] as { minSimilarity?: number };
    expect(policy.minSimilarity).toBe(0);
  });

  it.each([['abc'], ['-1'], ['2'], ['NaN']])(
    'env inválida (%s) cai no default 0.25 (fail-safe)',
    async (raw) => {
      process.env[ENV_KEY] = raw;
      const service = makeService();
      await service.retrieve('q', 4, {});
      const policy = retrieveSpy.mock.calls[0][1] as { minSimilarity?: number };
      expect(policy.minSimilarity).toBe(0.25);
    },
  );
});

describe('Spec 029 — conteúdo indexado sem id citável', () => {
  let sqliteDb: Database.Database | null = null;

  afterEach(() => {
    sqliteDb?.close();
    sqliteDb = null;
  });

  it('buildChatContent não emite "Demanda {id}" e preserva o título', () => {
    const sqlite = new Database(':memory:');
    sqliteDb = sqlite;
    const db = drizzle(sqlite);
    const service = new RefinementRAGService(db as unknown as DbClient);

    const content = (
      service as unknown as {
        buildChatContent: (title: string, messages: unknown[]) => string;
      }
    ).buildChatContent('Título da demanda histórica', [
      { agent: 'po', message: 'mensagem 1', type: 'completed' },
      { agent: 'qa', message: 'mensagem 2', type: 'completed' },
    ]);

    expect(content).not.toMatch(/Demanda\s+\d+/);
    expect(content).toContain('Refinamento anterior: Título da demanda histórica');
    expect(content).toContain('[po] mensagem 1');
    expect(content).toContain('[qa] mensagem 2');
  });
});

describe('Spec 029 — instrução anti-confusão temporal no guardrail', () => {
  it('header avisa que os documentos são histórico de outras demandas', () => {
    const output = formatRetrievedAsData(
      [
        {
          sourceKey: 'CHAT_10059',
          docType: 'ChatHistory',
          content: 'conteúdo histórico',
          repoFullName: 'owner/repo',
          demandId: 10059,
          blocked: false,
          detectionReasons: [],
        },
      ],
      ' repo:owner/repo',
    );

    expect(output).toContain('HISTÓRICO de outras demandas');
    expect(output).toContain('NÃO pertencem à demanda atual');
    // Metadado estruturado segue presente para rastreabilidade.
    expect(output).toContain('demand:10059');
  });
});
