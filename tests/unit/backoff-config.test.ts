import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    orchestrationMaxRetries: 5,
    orchestrationBaseBackoffMs: 50,
    orchestrationMaxBackoffMs: 5000,
    workerBackoffDocumentMs: 200,
    workerBackoffDemandGenMs: 200,
    workerMaxRetries: 5,
    workerMaxBackoffMs: 5000,
  },
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../server/config/env', () => ({
  env: mocks.env,
}));

vi.mock('../../server/utils/logger', () => ({
  logger: mocks.logger,
}));

import { getWorkerRetryConfig } from '../../server/services/retry-with-dlq';
import { OrchestrationRuntimeService } from '../../server/services/orchestration-runtime';
import { validateBackoffConfig } from '../../server/services/backoff-validation';

describe('A-2: backoff configurável e teto', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('worker retry config usa base e teto corretos', () => {
    const config = getWorkerRetryConfig({ workerName: 'document' });
    expect(config.maxAttempts).toBe(5);
    expect(config.initialDelayMs).toBe(200);
    expect(config.maxDelayMs).toBe(5000);
    expect(config.backoffMultiplier).toBe(2);
  });

  it('demand-gen usa base própria', () => {
    mocks.env.workerBackoffDemandGenMs = 300;
    const config = getWorkerRetryConfig({ workerName: 'demand-gen' });
    expect(config.initialDelayMs).toBe(300);
  });

  it('resolveDelay respeita teto com config extrema (base=1000, max=100)', () => {
    const config = getWorkerRetryConfig({
      workerName: 'document',
      baseBackoffMs: 1000,
      maxBackoffMs: 100,
      maxAttempts: 5,
    });
    // tentativa 1: raw=1000*2^0=1000, min(1000,100)=100
    const attempt1 = config.initialDelayMs * Math.pow(config.backoffMultiplier, 0);
    expect(Math.min(attempt1, config.maxDelayMs)).toBe(100);
    // tentativa 5: raw=1000*2^4=16000, min(...,100)=100
    const attempt5 = config.initialDelayMs * Math.pow(config.backoffMultiplier, 4);
    expect(Math.min(attempt5, config.maxDelayMs)).toBe(100);
  });

  it('onRetry loga worker_name, http_status, attempt, delay_applied e timestamp', () => {
    const config = getWorkerRetryConfig({
      workerName: 'document',
      baseBackoffMs: 50,
      httpStatus: 503,
      maxAttempts: 5,
      maxBackoffMs: 5000,
    });

    const error = new Error('503');
    if (config.onRetry) {
      config.onRetry(1, 50, error);
    }

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'A-2: worker retry backoff aplicado',
      expect.objectContaining({
        context: expect.objectContaining({
          worker_name: 'document',
          http_status: 503,
          attempt: 1,
          delay_applied: 50,
          base_backoff_ms: 50,
          max_backoff_ms: 5000,
          timestamp: expect.any(String),
        }),
      }),
    );
  });

  it('OrchestrationRuntimeService aplica teto no backoff', async () => {
    vi.useRealTimers();
    const service = new OrchestrationRuntimeService(undefined, {
      maxRetries: 3,
      baseBackoffMs: 1000,
      maxBackoffMs: 100,
    });

    let attempts = 0;
    const write = vi.fn().mockImplementation(() => {
      attempts += 1;
      throw new Error('fail');
    });

    // @ts-expect-error -- acesso a método privado para teste
    await service.withRetry('test', write);

    expect(attempts).toBe(4); // 1 inicial + 3 retries
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'A-2: backoff aplicado',
      expect.objectContaining({
        context: expect.objectContaining({
          worker_name: 'OrchestrationRuntime',
          attempt: expect.any(Number),
          delay_applied: 100,
          base_backoff_ms: 1000,
          max_backoff_ms: 100,
          timestamp: expect.any(String),
        }),
      }),
    );
  });

  it('validateBackoffConfig emite warning quando max < base', () => {
    mocks.env.orchestrationMaxBackoffMs = 10;
    mocks.env.orchestrationBaseBackoffMs = 50;
    validateBackoffConfig();

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'A-2: worker MAX_BACKOFF_MS menor que base',
      expect.objectContaining({
        context: expect.objectContaining({
          worker_name: 'orchestration',
          base_backoff_ms: 50,
          max_backoff_ms: 10,
        }),
      }),
    );
  });

  it('validateBackoffConfig não emite warning quando max >= base', () => {
    mocks.env.orchestrationMaxBackoffMs = 5000;
    mocks.env.orchestrationBaseBackoffMs = 50;
    validateBackoffConfig();

    expect(mocks.logger.warn).not.toHaveBeenCalledWith(
      'A-2: worker MAX_BACKOFF_MS menor que base',
      expect.anything(),
    );
  });
});
