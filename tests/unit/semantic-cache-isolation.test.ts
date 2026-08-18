import { beforeEach, describe, expect, it, vi } from 'vitest';

const embeddingMock = vi.hoisted(() => ({
  getEmbedding: vi.fn(async (text: string) => {
    // Embedding determinístico simples: mesmo texto => mesmo vetor.
    const seed = text.length % 7;
    return [1, 0.5 + seed * 0.01, 0.25];
  }),
  cosineSimilarity: vi.fn(() => 0.99),
}));

vi.mock('../../server/services/embedding-service', () => ({
  embeddingService: embeddingMock,
}));

vi.mock('../../server/metrics/collector', () => ({
  metricsCollector: { recordCacheHit: vi.fn(), recordCacheMiss: vi.fn() },
}));

vi.mock('../../server/services/cache-adapter', () => ({
  getCacheStore: vi.fn(() => null),
}));

import {
  computeContextFingerprint,
  SemanticCacheService,
} from '../../server/services/semantic-cache';

const FP_A = computeContextFingerprint({
  systemMessages: [{ role: 'system', content: 'persona A' }],
  cacheContext: { repo: 'org/app' },
  temperature: 0.2,
  maxTokens: 1000,
  responseFormat: 'text',
})!;

describe('Isolamento contextual do cache semântico (spec 015 B1 / H-04)', () => {
  let cache: SemanticCacheService;

  beforeEach(async () => {
    cache = new SemanticCacheService({ enabled: true, similarityThreshold: 0.85 });
    await cache.set(
      'qual o prazo do projeto alpha?',
      'resposta do contexto A com conteudo suficiente',
      'or:m1',
      'chat',
      undefined,
      FP_A,
    );
  });

  it('hit com texto similar E contexto idêntico (US1-AS1)', async () => {
    const hit = await cache.get('qual o prazo do projeto alpha?', 'or:m1', 'chat', FP_A);
    expect(hit?.response).toBe('resposta do contexto A com conteudo suficiente');
  });

  it.each([
    [
      'system prompt diferente',
      {
        systemMessages: [{ role: 'system', content: 'persona B' }],
        cacheContext: { repo: 'org/app' },
        temperature: 0.2,
        maxTokens: 1000,
        responseFormat: 'text',
      },
    ],
    [
      'cacheContext (repo) diferente',
      {
        systemMessages: [{ role: 'system', content: 'persona A' }],
        cacheContext: { repo: 'org/outro' },
        temperature: 0.2,
        maxTokens: 1000,
        responseFormat: 'text',
      },
    ],
    [
      'temperatura diferente',
      {
        systemMessages: [{ role: 'system', content: 'persona A' }],
        cacheContext: { repo: 'org/app' },
        temperature: 0.9,
        maxTokens: 1000,
        responseFormat: 'text',
      },
    ],
    [
      'maxTokens diferente',
      {
        systemMessages: [{ role: 'system', content: 'persona A' }],
        cacheContext: { repo: 'org/app' },
        temperature: 0.2,
        maxTokens: 4000,
        responseFormat: 'text',
      },
    ],
  ])('SC-001: nenhum hit cruzado com %s', async (_label, ctx) => {
    const otherFp = computeContextFingerprint(ctx)!;
    expect(otherFp).not.toBe(FP_A);
    const hit = await cache.get('qual o prazo do projeto alpha?', 'or:m1', 'chat', otherFp);
    expect(hit).toBeNull();
  });

  it('entrada legada sem fingerprint é inelegível (US1-AS3)', async () => {
    const legacy = new SemanticCacheService({ enabled: true });
    // Simula entrada antiga gravada sem fingerprint (bypass do set público).
    (legacy as unknown as { entries: unknown[] }).entries.push({
      queryEmbedding: [1, 0.5, 0.25],
      queryText: 'pergunta antiga',
      response: 'resposta antiga',
      model: 'or:m1',
      operation: 'chat',
      embeddingModel: 'qwen/qwen3-embedding-8b',
      dimensions: 3072,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60000,
      hits: 0,
    });
    const hit = await legacy.get('pergunta antiga', 'or:m1', 'chat', FP_A);
    expect(hit).toBeNull();
  });

  it('lookup sem fingerprint não retorna hit; set sem fingerprint não grava (FR-003)', async () => {
    expect(
      await cache.get('qual o prazo do projeto alpha?', 'or:m1', 'chat', undefined),
    ).toBeNull();
    const fresh = new SemanticCacheService({ enabled: true });
    await fresh.set(
      'texto qualquer suficientemente longo',
      'resposta com mais de vinte caracteres',
      'or:m1',
      'chat',
    );
    expect(fresh.getStats().size).toBe(0);
  });

  it('troca de modelo resulta em miss (A-1)', async () => {
    const hit = await cache.get('qual o prazo do projeto alpha?', 'or:m2', 'chat', FP_A);
    expect(hit).toBeNull();
  });

  it('mesmo modelo e embedding similar resulta em hit (A-1 happy path)', async () => {
    const hit = await cache.get('prazo do projeto alpha', 'or:m1', 'chat', FP_A);
    expect(hit?.response).toBe('resposta do contexto A com conteudo suficiente');
  });

  it('fingerprint é estável para o mesmo contexto e null para contexto não serializável', () => {
    const again = computeContextFingerprint({
      systemMessages: [{ role: 'system', content: 'persona A' }],
      cacheContext: { repo: 'org/app' },
      temperature: 0.2,
      maxTokens: 1000,
      responseFormat: 'text',
    });
    expect(again).toBe(FP_A);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(computeContextFingerprint({ systemMessages: [], cacheContext: circular })).toBeNull();
  });

  // Auditoria 2026-08-01 (A09): a spec 10259 T5 usava `promptHash ?? systemMessages`,
  // então o promptHash APAGAVA as mensagens do fingerprint. Como o prompt efetivo vem
  // de YAML/DB além do arquivo em disco, prompts diferentes colidiam na mesma chave.
  describe('promptHash não pode apagar systemMessages do fingerprint (A09)', () => {
    const base = {
      cacheContext: { repo: 'org/app' },
      temperature: 0.2,
      maxTokens: 1000,
      responseFormat: 'text' as const,
    };

    it('systemMessages distintas geram fingerprints distintos MESMO com o mesmo promptHash', () => {
      const a = computeContextFingerprint({
        ...base,
        systemMessages: [{ role: 'system', content: 'persona A' }],
        promptHash: 'sha256-do-arquivo',
      });
      const b = computeContextFingerprint({
        ...base,
        systemMessages: [{ role: 'system', content: 'persona B' }],
        promptHash: 'sha256-do-arquivo',
      });

      expect(a).not.toBeNull();
      expect(a).not.toBe(b);
    });

    it('promptHash distinto ainda invalida com as mesmas systemMessages', () => {
      const systemMessages = [{ role: 'system', content: 'persona A' }];
      const v1 = computeContextFingerprint({ ...base, systemMessages, promptHash: 'hash-v1' });
      const v2 = computeContextFingerprint({ ...base, systemMessages, promptHash: 'hash-v2' });

      expect(v1).not.toBe(v2);
    });

    it('ausência de promptHash não colide com presença de promptHash', () => {
      const systemMessages = [{ role: 'system', content: 'persona A' }];
      const semHash = computeContextFingerprint({ ...base, systemMessages });
      const comHash = computeContextFingerprint({ ...base, systemMessages, promptHash: 'h' });

      expect(semHash).not.toBe(comHash);
    });
  });
});
