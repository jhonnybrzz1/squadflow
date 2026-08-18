import { beforeEach, describe, expect, it, vi } from 'vitest';

const embeddingMock = vi.hoisted(() => ({
  getEmbedding: vi.fn(async (text: string) => {
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

const FP = computeContextFingerprint({
  systemMessages: [{ role: 'system', content: 'persona' }],
  cacheContext: { repo: 'org/app' },
  temperature: 0.2,
  maxTokens: 1000,
  responseFormat: 'text',
})!;

describe('M-1: invalidação por corpus version no cache semântico', () => {
  let cache: SemanticCacheService;

  beforeEach(async () => {
    cache = new SemanticCacheService({ enabled: true, similarityThreshold: 0.85 });
    await cache.set(
      'qual o prazo do projeto alpha?',
      'resposta da versão 1',
      'or:m1',
      'chat',
      undefined,
      FP,
    );
  });

  it('hit normal com mesma corpus version', async () => {
    const hit = await cache.get('qual o prazo do projeto alpha?', 'or:m1', 'chat', FP);
    expect(hit?.response).toBe('resposta da versão 1');
    expect(cache.getStats().totalHits).toBe(1);
  });

  it('após incremento de corpus version, entrada anterior é purgada lazy (stale miss)', async () => {
    const before = cache.getCurrentCorpusVersion();
    await cache.incrementCorpusVersion();
    expect(cache.getCurrentCorpusVersion()).toBe(before + 1);

    const hit = await cache.get('qual o prazo do projeto alpha?', 'or:m1', 'chat', FP);
    expect(hit).toBeNull();

    const stats = cache.getStats();
    expect(stats.totalMisses).toBe(1);
    expect(stats.staleCount).toBe(1);
  });

  it('resposta fresh é armazenada com a nova corpus version', async () => {
    await cache.incrementCorpusVersion();
    await cache.set(
      'qual o prazo do projeto alpha?',
      'resposta da versão 2',
      'or:m1',
      'chat',
      undefined,
      FP,
    );

    const hit = await cache.get('qual o prazo do projeto alpha?', 'or:m1', 'chat', FP);
    expect(hit?.response).toBe('resposta da versão 2');
    expect(cache.getStats().totalHits).toBe(1);
  });

  it('rejeita corpus_version=0 ao setar', async () => {
    const c = new SemanticCacheService({ enabled: true });
    // Versão começa em 1 por padrão; forçamos 0 para testar rejeição
    await c.setCorpusVersion(1);
    // Simula tentativa de set com currentCorpusVersion=0 via manipulação interna
    (c as unknown as { currentCorpusVersion: number }).currentCorpusVersion = 0;

    await c.set('outra pergunta', 'resposta com corpus 0', 'or:m1', 'chat', undefined, FP);
    const hit = await c.get('outra pergunta', 'or:m1', 'chat', FP);
    expect(hit).toBeNull();
  });

  it('setCorpusVersion rejeita explicitamente valor 0', async () => {
    await expect(cache.setCorpusVersion(0)).rejects.toThrow('corpus_version=0');
  });

  it('flush manual do cache mantém consistência da corpus version', () => {
    const version = cache.getCurrentCorpusVersion();
    cache.clear();
    expect(cache.getCurrentCorpusVersion()).toBe(version);
    expect(cache.getStats().size).toBe(0);
  });

  it('entrada legada com corpusVersion inferior é purgada lazy após incremento', async () => {
    const legacy = new SemanticCacheService({ enabled: true });
    (legacy as unknown as { entries: unknown[] }).entries.push({
      queryEmbedding: [1, 0.5, 0.25],
      queryText: 'pergunta antiga',
      response: 'resposta antiga',
      model: 'or:m1',
      operation: 'chat',
      embeddingModel: 'qwen/qwen3-embedding-8b',
      dimensions: 3072,
      contextFingerprint: FP,
      corpusVersion: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60000,
      hits: 0,
    });

    const before = legacy.getCurrentCorpusVersion();
    await legacy.incrementCorpusVersion();
    expect(legacy.getCurrentCorpusVersion()).toBe(before + 1);

    const hit = await legacy.get('pergunta antiga', 'or:m1', 'chat', FP);
    expect(hit).toBeNull();
    expect(legacy.getStats().staleCount).toBe(1);
  });
});
