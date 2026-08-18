import { createHash } from 'crypto';
import type { Demand } from '@shared/schema';
import { logger } from '../utils/logger';

export interface CacheKey {
  inputHash: string;
  branch: string;
  sha: string;
  demandType: string;
}

export interface CacheEntry {
  payload: string;
  expiresAt: number;
  createdAt: number;
  lastAccessedAt: number;
}

export interface ContextCacheLogEntry {
  timestamp: string;
  inputHash: string;
  branch: string;
  sha: string;
  latencyMs: number;
  demandType: string;
  hit: boolean;
}

/**
 * M-3: cache intermediário para contexto de repositório.
 *
 * - Chave composta: hash(título+descrição+tipo+domínio) + branch + sha + demandType.
 * - TTL configurável por demanda via `ttlByDemandType`.
 * - Lazy expiration no GET.
 * - Limpeza por threshold: 500 keys (remove expiradas, depois 25% menos acessadas).
 * - Instrumentação em JSON lines via logger.
 */
export class ContextCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly recentInputs = new Map<string, number[]>();
  private readonly ttlByDemandType: Map<string, number>;
  private readonly defaultTtlMs: number;
  private readonly maxKeys: number;
  private readonly instrumentationSampleSize = 50;
  private instrumentationCount = 0;

  constructor(
    ttlByDemandType: Map<string, number> = new Map(),
    defaultTtlMs = 5 * 60 * 1000,
    maxKeys = 500,
  ) {
    this.ttlByDemandType = ttlByDemandType;
    this.defaultTtlMs = defaultTtlMs;
    this.maxKeys = maxKeys;
  }

  /**
   * Retorna o TTL para o tipo de demanda, ou default.
   */
  getTtlMs(demandType: string): number {
    return this.ttlByDemandType.get(demandType) ?? this.defaultTtlMs;
  }

  /**
   * Gera a chave composta do cache.
   */
  buildKey(demand: Demand, branch: string, sha: string): string {
    const input = JSON.stringify({
      title: demand.title,
      description: demand.description,
      type: demand.type,
      domain: demand.domain ?? 'padrao',
    });
    const inputHash = createHash('sha256').update(input).digest('hex');
    return `${inputHash}:${branch}:${sha}:${demand.type}`;
  }

  /**
   * Gera apenas o hash de input (usado para métrica de repetição).
   */
  buildInputHash(demand: Demand): string {
    const input = JSON.stringify({
      title: demand.title,
      description: demand.description,
      type: demand.type,
      domain: demand.domain ?? 'padrao',
    });
    return createHash('sha256').update(input).digest('hex');
  }

  /**
   * M-3: GET com lazy expiration.
   */
  get(demand: Demand, branch: string, sha: string): string | undefined {
    const key = this.buildKey(demand, branch, sha);
    const entry = this.store.get(key);

    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    entry.lastAccessedAt = Date.now();
    return entry.payload;
  }

  /**
   * M-3: SET com TTL por tipo de demanda.
   */
  set(demand: Demand, branch: string, sha: string, payload: string): void {
    const key = this.buildKey(demand, branch, sha);
    const ttlMs = this.getTtlMs(demand.type);
    const now = Date.now();

    this.store.set(key, {
      payload,
      expiresAt: now + ttlMs,
      createdAt: now,
      lastAccessedAt: now,
    });

    this.recordInput(demand, now);
    this.enforceThreshold();
  }

  /**
   * M-3: registra ocorrência de input para cálculo de taxa de repetição.
   */
  private recordInput(demand: Demand, timestamp: number): void {
    const inputHash = this.buildInputHash(demand);
    const timestamps = this.recentInputs.get(inputHash) ?? [];
    const windowStart = timestamp - 5 * 60 * 1000;
    const filtered = timestamps.filter((t) => t >= windowStart);
    filtered.push(timestamp);
    this.recentInputs.set(inputHash, filtered);
  }

  /**
   * M-3: calcula taxa de repetição em janela de 5 minutos.
   * Retorna percentual de chamadas que são repetições de um inputHash.
   */
  calculateRepetitionRate(windowMs = 5 * 60 * 1000): number {
    const now = Date.now();
    const windowStart = now - windowMs;
    let total = 0;
    let repeated = 0;

    for (const [, timestamps] of this.recentInputs) {
      const inWindow = timestamps.filter((t) => t >= windowStart);
      if (inWindow.length === 0) continue;
      total += inWindow.length;
      if (inWindow.length > 1) repeated += inWindow.length;
    }

    if (total === 0) return 0;
    return repeated / total;
  }

  /**
   * M-3: threshold de 500 keys. Remove expiradas; se ainda acima, remove 25% menos acessadas.
   */
  private enforceThreshold(): void {
    if (this.store.size <= this.maxKeys) return;

    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt < now) {
        this.store.delete(key);
      }
    }

    if (this.store.size <= this.maxKeys) return;

    const sorted = [...this.store.entries()].sort(
      (a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt,
    );
    const removeCount = Math.ceil(sorted.length * 0.25);
    for (let i = 0; i < removeCount; i++) {
      this.store.delete(sorted[i][0]);
    }
  }

  /**
   * M-3: instrumentação em JSON lines. Limita a 50 amostras iniciais, depois loga a cada 10.
   */
  logInstrumentation(entry: ContextCacheLogEntry): void {
    this.instrumentationCount++;
    if (this.instrumentationCount <= this.instrumentationSampleSize) {
      logger.info('M-3 context-cache instrumentation', { context: entry });
    } else if (this.instrumentationCount % 10 === 0) {
      logger.info('M-3 context-cache instrumentation', { context: entry });
    }
  }

  /**
   * Limpa todo o cache (útil em testes).
   */
  clear(): void {
    this.store.clear();
    this.recentInputs.clear();
    this.instrumentationCount = 0;
  }

  /**
   * Retorna estatísticas atuais do cache.
   */
  stats(): { size: number; repetitionRate: number } {
    return {
      size: this.store.size,
      repetitionRate: this.calculateRepetitionRate(),
    };
  }
}

export const contextCache = new ContextCache();
