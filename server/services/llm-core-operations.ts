/**
 * LLM Core Operations
 *
 * Consolidation of trivial, single-responsibility LLM "operations" managers that
 * were previously scattered across micro-modules. This file keeps the public
 * APIs stable so existing consumers (openai-ai.ts, tests) can migrate gradually.
 *
 * Previously standalone modules merged here:
 * - llm-request-id-operations.ts
 * - llm-concurrency-operations.ts
 * - llm-client-management-operations.ts
 */

import { mapWithConcurrency } from './llm-utils';
import { llmClientManager, type AIProvider } from './llm-client-manager';

export class RequestIdManager {
  private counter = 0;

  generateRequestId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 9);
    this.counter += 1;
    return `req_${timestamp}_${random}_${this.counter}`;
  }

  generateRequestIdWithPrefix(prefix: string): string {
    return `${prefix}_${this.generateRequestId()}`;
  }

  isValidRequestId(requestId: string): boolean {
    return /^req_\d+_[a-z0-9]+_\d+$/.test(requestId);
  }

  extractTimestamp(requestId: string): number | null {
    const match = requestId.match(/^req_(\d+)_/);
    return match ? parseInt(match[1], 10) : null;
  }

  resetCounter(): void {
    this.counter = 0;
  }
}

export const requestIdManager = new RequestIdManager();

export interface ConcurrencyOptions {
  value?: number;
  defaultValue?: number;
  maxValue?: number;
}

export class ConcurrencyManager {
  private readonly DEFAULT_BATCH_CONCURRENCY = 4;
  private readonly MAX_BATCH_CONCURRENCY = 10;

  resolveConcurrency(options: ConcurrencyOptions): number {
    const value = options.value ?? options.defaultValue ?? this.DEFAULT_BATCH_CONCURRENCY;
    const max = options.maxValue ?? this.MAX_BATCH_CONCURRENCY;

    if (!Number.isFinite(value) || value <= 0) {
      return this.DEFAULT_BATCH_CONCURRENCY;
    }

    return Math.max(1, Math.min(max, Math.floor(value)));
  }

  async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    return mapWithConcurrency(items, concurrency, worker);
  }

  determineIdealConcurrency(batchSize: number): number {
    if (batchSize <= 1) return 1;
    if (batchSize <= 5) return 2;
    if (batchSize <= 10) return 4;
    if (batchSize <= 20) return 6;
    return this.MAX_BATCH_CONCURRENCY;
  }
}

export const concurrencyManager = new ConcurrencyManager();

export class ClientManagementManager {
  getClient(provider: AIProvider) {
    return llmClientManager.getClient(provider);
  }

  hasClient(provider: AIProvider): boolean {
    return llmClientManager.hasClient(provider);
  }

  getAvailableProviders(): AIProvider[] {
    const providers: AIProvider[] = [];
    if (this.hasClient('openai')) providers.push('openai');
    if (this.hasClient('openrouter')) providers.push('openrouter');
    return providers;
  }

  hasAnyClient(): boolean {
    return this.hasClient('openai') || this.hasClient('openrouter');
  }

  getDefaultProvider(): AIProvider {
    if (this.hasClient('openrouter')) return 'openrouter';
    if (this.hasClient('openai')) return 'openai';
    throw new Error('No LLM client available');
  }
}

export const clientManagementManager = new ClientManagementManager();
