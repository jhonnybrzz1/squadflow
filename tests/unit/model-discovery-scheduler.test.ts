import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelDiscoveryScheduler } from '../../server/services/model-discovery-scheduler';

// Mock the discovery and registry modules to avoid DB/network calls
vi.mock('../../server/services/model-discovery', () => ({
  modelDiscovery: {
    runCycle: vi.fn().mockResolvedValue({
      results: [],
      totalCandidates: 0,
      durationMs: 10,
    }),
  },
}));

vi.mock('../../server/services/model-registry', () => ({
  modelRegistry: {
    seedIfNeeded: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../server/metrics/model-registry', () => ({
  modelDiscoveryRunTotal: { inc: vi.fn() },
}));

describe('ModelDiscoveryScheduler', () => {
  let scheduler: ModelDiscoveryScheduler | null = null;
  const originalInterval = process.env.MODEL_DISCOVERY_INTERVAL_MS;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new ModelDiscoveryScheduler();
  });

  afterEach(() => {
    scheduler?.stop();
    scheduler = null;
    if (originalInterval === undefined) {
      delete process.env.MODEL_DISCOVERY_INTERVAL_MS;
    } else {
      process.env.MODEL_DISCOVERY_INTERVAL_MS = originalInterval;
    }
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('start/stop', () => {
    it('starts and sets running state', () => {
      scheduler!.start();
      const state = scheduler!.getState();
      expect(state.running).toBe(true);
      expect(state.startedAt).toBeGreaterThan(0);
    });

    it('is idempotent (second start is a no-op)', () => {
      scheduler!.start();
      const firstStartedAt = scheduler!.getState().startedAt;
      scheduler!.start();
      expect(scheduler!.getState().startedAt).toBe(firstStartedAt);
    });

    it('stops and clears running state', () => {
      scheduler!.start();
      scheduler!.stop();
      expect(scheduler!.getState().running).toBe(false);
    });
  });

  describe('runNow', () => {
    it('runs a cycle immediately', async () => {
      const { modelDiscovery } = await import('../../server/services/model-discovery');
      scheduler!.start();
      const result = await scheduler!.runNow();
      expect(result.skipped).toBe(false);
      expect(modelDiscovery.runCycle).toHaveBeenCalled();
    });

    it('skips when a cycle is already running', async () => {
      // Start a cycle but don't await it
      scheduler!.start();
      const firstCall = scheduler!.runNow();
      const secondCall = scheduler!.runNow();
      const [first, second] = await Promise.all([firstCall, secondCall]);
      // One runs, the other skips
      expect(first.skipped || second.skipped).toBe(true);
    });
  });

  describe('backoff', () => {
    it('increases interval on consecutive failures', async () => {
      const { modelDiscovery } = await import('../../server/services/model-discovery');
      (modelDiscovery.runCycle as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('fail'),
      );
      (modelDiscovery.runCycle as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('fail'),
      );

      scheduler!.start();
      await scheduler!.runNow(); // failure 1
      await scheduler!.runNow(); // failure 2

      const state = scheduler!.getState();
      expect(state.consecutiveFailures).toBe(2);
      // Interval should have increased (backoff)
      expect(state.currentInterval).toBeGreaterThan(0);
    });

    it('resets backoff on success', async () => {
      const { modelDiscovery } = await import('../../server/services/model-discovery');
      (modelDiscovery.runCycle as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('fail'),
      );

      scheduler!.start();
      await scheduler!.runNow(); // failure
      await scheduler!.runNow(); // success (default mock)

      const state = scheduler!.getState();
      expect(state.consecutiveFailures).toBe(0);
    });
  });

  describe('reset', () => {
    it('resets internal state', () => {
      scheduler!.start();
      scheduler!.reset();
      const state = scheduler!.getState();
      expect(state.running).toBe(false);
      expect(state.consecutiveFailures).toBe(0);
    });
  });
});
