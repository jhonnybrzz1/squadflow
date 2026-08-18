import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { ContextCache } from '../../server/services/context-cache';
import type { Demand } from '@shared/schema';

const createDemand = (overrides: Partial<Demand> = {}): Demand =>
  ({
    id: 1,
    title: 'Melhorar login',
    description: 'Adicionar 2FA',
    type: 'melhoria',
    domain: 'padrao',
    priority: 'media',
    status: 'processing',
    progress: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as unknown as Demand;

describe('M-3: ContextCache', () => {
  let cache: ContextCache;

  beforeEach(() => {
    cache = new ContextCache();
  });

  afterEach(() => {
    cache.clear();
    vi.useRealTimers();
  });

  it('cache hit para mesmo tipo, branch e sha', () => {
    const demand = createDemand();
    cache.set(demand, 'main', 'abc123', 'repo context');
    const hit = cache.get(demand, 'main', 'abc123');
    expect(hit).toBe('repo context');
  });

  it('cache miss para demanda diferente (input hash muda)', () => {
    const d1 = createDemand({ title: 'A' });
    cache.set(d1, 'main', 'abc123', 'context A');
    const d2 = createDemand({ title: 'B' });
    expect(cache.get(d2, 'main', 'abc123')).toBeUndefined();
  });

  it('cache miss quando branch muda', () => {
    const demand = createDemand();
    cache.set(demand, 'main', 'abc123', 'repo context');
    expect(cache.get(demand, 'feature-x', 'abc123')).toBeUndefined();
  });

  it('cache miss quando sha muda', () => {
    const demand = createDemand();
    cache.set(demand, 'main', 'abc123', 'repo context');
    expect(cache.get(demand, 'main', 'def456')).toBeUndefined();
  });

  it('TTL configurável por tipo de demanda', () => {
    const ttlMap = new Map([['melhoria', 100]]);
    cache = new ContextCache(ttlMap, 5000);
    const demand = createDemand();
    cache.set(demand, 'main', 'abc123', 'repo context');

    expect(cache.get(demand, 'main', 'abc123')).toBe('repo context');

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 150);
    expect(cache.get(demand, 'main', 'abc123')).toBeUndefined();
  });

  it('lazy expiration remove entrada expirada no GET', () => {
    const ttlMap = new Map([['melhoria', 1]]);
    cache = new ContextCache(ttlMap, 5000);
    const demand = createDemand();
    cache.set(demand, 'main', 'abc123', 'repo context');

    expect(cache.stats().size).toBe(1);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2);
    expect(cache.get(demand, 'main', 'abc123')).toBeUndefined();
    expect(cache.stats().size).toBe(0);
  });

  it('limpeza por threshold remove entradas expiradas primeiro', () => {
    cache = new ContextCache(new Map(), 1, 5);
    const now = Date.now();

    for (let i = 0; i < 10; i++) {
      const demand = createDemand({ title: `Demand ${i}` });
      cache.set(demand, 'main', `sha${i}`, `context ${i}`);
    }

    vi.useFakeTimers();
    vi.setSystemTime(now + 10);
    cache.enforceThreshold();
    expect(cache.stats().size).toBeLessThanOrEqual(5);
  });

  it('taxa de repetição começa em 0', () => {
    expect(cache.calculateRepetitionRate()).toBe(0);
  });

  it('taxa de repetição detecta repetições em janela de 5 min', () => {
    const demand = createDemand();
    cache.set(demand, 'main', 'abc123', 'a');
    cache.set(demand, 'main', 'abc123', 'a');
    cache.set(demand, 'main', 'abc123', 'a');
    const different = createDemand({ title: 'Outra' });
    cache.set(different, 'main', 'abc123', 'b');

    const rate = cache.calculateRepetitionRate(5 * 60 * 1000);
    expect(rate).toBeGreaterThan(0);
  });

  it('input hash igual para demandas com mesmo input', () => {
    const d1 = createDemand();
    const d2 = createDemand({ id: 2 });
    expect(cache.buildInputHash(d1)).toBe(cache.buildInputHash(d2));
  });

  it('input hash difere com título diferente', () => {
    const d1 = createDemand();
    const d2 = createDemand({ title: 'Outro título' });
    expect(cache.buildInputHash(d1)).not.toBe(cache.buildInputHash(d2));
  });
});
