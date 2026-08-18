import {
  classifyBalance,
  openRouterCreditsPayloadSchema,
  type BalanceResponse,
  type BalanceSnapshot,
} from '@shared/billing-balance';
import { openRouterBalanceRefreshTotal, openRouterBalanceStateTotal } from '../metrics';
import { logger } from '../utils/logger';

// Saldo da conta (créditos comprados − uso total), igual ao dashboard do OpenRouter.
const OPENROUTER_BALANCE_URL = 'https://openrouter.ai/api/v1/credits';
const DEFAULT_TTL_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_LOW_BALANCE_USD = 1;

type FetchLike = typeof fetch;

export interface OpenRouterBalanceServiceOptions {
  fetchFn?: FetchLike;
  now?: () => number;
  apiKey?: () => string | undefined;
  lowBalanceThreshold?: number;
  ttlMs?: number;
  timeoutMs?: number;
}

export function parseLowBalanceThreshold(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_LOW_BALANCE_USD;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  logger.warn('Invalid OpenRouter low balance threshold; using safe default', {
    context: { config: 'OPENROUTER_LOW_BALANCE_USD', fallbackUsd: DEFAULT_LOW_BALANCE_USD },
  });
  return DEFAULT_LOW_BALANCE_USD;
}

export class OpenRouterBalanceService {
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly apiKey: () => string | undefined;
  private readonly lowBalanceThreshold: number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private snapshot: BalanceSnapshot | null = null;
  private expiresAt = 0;
  private staleSince: string | null = null;
  private inFlight: Promise<BalanceResponse> | null = null;
  private lastLoggedEmptySnapshot: string | null = null;

  constructor(options: OpenRouterBalanceServiceOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.apiKey = options.apiKey ?? (() => process.env.OPENROUTER_API_KEY);
    this.lowBalanceThreshold =
      options.lowBalanceThreshold ??
      parseLowBalanceThreshold(process.env.OPENROUTER_LOW_BALANCE_USD);
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getBalance(): Promise<BalanceResponse> {
    if (this.snapshot && this.now() < this.expiresAt) {
      return this.toResponse(this.snapshot, false);
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.refresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  reset(): void {
    this.snapshot = null;
    this.expiresAt = 0;
    this.staleSince = null;
    this.inFlight = null;
    this.lastLoggedEmptySnapshot = null;
  }

  private async refresh(): Promise<BalanceResponse> {
    try {
      const snapshot = await this.fetchSnapshot();
      this.snapshot = snapshot;
      this.expiresAt = this.now() + this.ttlMs;
      this.staleSince = null;
      openRouterBalanceRefreshTotal.labels('success').inc();
      openRouterBalanceStateTotal.labels(snapshot.status).inc();

      if (snapshot.status === 'empty' && this.lastLoggedEmptySnapshot !== snapshot.cachedAt) {
        this.lastLoggedEmptySnapshot = snapshot.cachedAt;
        logger.warn('OpenRouter balance exhausted', {
          context: { event: 'openrouter_balance_exhausted', cachedAt: snapshot.cachedAt },
        });
      }
      return this.toResponse(snapshot, false);
    } catch (error) {
      if (this.snapshot) {
        this.staleSince ??= new Date(this.now()).toISOString();
        openRouterBalanceRefreshTotal.labels('stale').inc();
        logger.warn('OpenRouter balance refresh failed; serving stale snapshot', {
          error: error instanceof Error ? error : undefined,
          context: { event: 'openrouter_balance_stale', staleSince: this.staleSince },
        });
        return this.toResponse(this.snapshot, true);
      }

      openRouterBalanceRefreshTotal.labels('unavailable').inc();
      logger.error('OpenRouter balance unavailable without cached snapshot', {
        error: error instanceof Error ? error : undefined,
        context: { event: 'openrouter_balance_unavailable' },
      });
      throw new Error('OpenRouter balance unavailable');
    }
  }

  private async fetchSnapshot(): Promise<BalanceSnapshot> {
    const apiKey = this.apiKey();
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not configured');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(OPENROUTER_BALANCE_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OpenRouter balance HTTP ${response.status}`);

      const payload = openRouterCreditsPayloadSchema.parse(await response.json());
      const { total_credits: totalCredits, total_usage: totalUsage } = payload.data;
      const balance = totalCredits - totalUsage;
      return {
        // `limit`/`usage` do snapshot passam a significar créditos totais / uso total
        // da conta (não mais teto da chave). `balance = limit - usage` continua válido.
        usage: totalUsage,
        limit: totalCredits,
        balance,
        currency: 'USD',
        cachedAt: new Date(this.now()).toISOString(),
        status: classifyBalance(balance, this.lowBalanceThreshold),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private toResponse(snapshot: BalanceSnapshot, stale: boolean): BalanceResponse {
    return {
      ...snapshot,
      stale,
      status: stale ? 'error' : snapshot.status,
    };
  }
}

export const openRouterBalanceService = new OpenRouterBalanceService();
