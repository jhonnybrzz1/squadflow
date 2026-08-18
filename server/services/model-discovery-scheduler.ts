/**
 * ModelDiscoveryScheduler — runs discovery cycles on a configurable interval
 * with lock, exponential backoff on failure, and jitter to avoid thundering
 * herd against provider APIs.
 *
 * Design:
 *  - Single in-process lock (per-instance). In multi-instance deployments,
 *    a DB-based lock should be added (future work).
 *  - Interval: MODEL_DISCOVERY_INTERVAL_MS (default 24h).
 *  - Backoff: doubles on consecutive failures, capped at 7 days.
 *  - Jitter: ±20% of the current interval, applied per cycle.
 *  - Never runs more than one cycle concurrently per instance.
 *  - Failures are logged and counted; the scheduler never crashes.
 *  - Startup seed: runs seedIfNeeded() once before the first cycle.
 */

import { modelDiscovery, type DiscoveryCycleResult } from './model-discovery';
import { modelRegistry } from './model-registry';
import { logger } from '../utils/logger';
import { modelDiscoveryRunTotal } from '../metrics/model-registry';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const JITTER_FACTOR = 0.2; // ±20%

function parseInterval(): number {
  const raw = parseInt(process.env.MODEL_DISCOVERY_INTERVAL_MS || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_INTERVAL_MS;
  return Math.min(Math.max(raw, MIN_INTERVAL_MS), MAX_INTERVAL_MS);
}

export class ModelDiscoveryScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private consecutiveFailures = 0;
  private currentInterval = parseInterval();
  private seeded = false;
  private startedAt = 0;

  /**
   * Starts the scheduler. Runs an initial seed, then schedules the first
   * cycle with jitter. Safe to call multiple times — subsequent calls are
   * no-ops when already running.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();

    logger.info('[model-discovery-scheduler] Starting', {
      context: { intervalMs: this.currentInterval },
    });

    // Seed the registry on startup (non-blocking)
    this.runSeed().catch((error) => {
      logger.warn('[model-discovery-scheduler] Seed failed (non-blocking)', {
        error: error instanceof Error ? error : undefined,
      });
    });

    this.scheduleNext();
  }

  /**
   * Stops the scheduler and clears any pending timer.
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('[model-discovery-scheduler] Stopped');
  }

  /**
   * Triggers an immediate discovery cycle (bypassing the schedule). Returns
   * the cycle result. Respects the concurrency lock — if a cycle is already
   * running, returns immediately with a skipped result.
   */
  async runNow(): Promise<{ skipped: boolean; result?: DiscoveryCycleResult }> {
    if (this.isCycleRunning) {
      return { skipped: true };
    }
    const result = await this.runCycleWithBackoff();
    return { skipped: false, result: result ?? undefined };
  }

  private isCycleRunning = false;

  private async runSeed(): Promise<void> {
    if (this.seeded) return;
    this.seeded = true;
    await modelRegistry.seedIfNeeded();
  }

  private scheduleNext(): void {
    if (!this.running) return;

    const jitter = this.computeJitter();
    const delay = this.currentInterval + jitter;

    this.timer = setTimeout(() => {
      this.runCycleWithBackoff().finally(() => this.scheduleNext());
    }, delay);

    logger.debug('[model-discovery-scheduler] Next cycle scheduled', {
      context: { delayMs: delay, intervalMs: this.currentInterval, jitterMs: jitter },
    });
  }

  private async runCycleWithBackoff(): Promise<DiscoveryCycleResult | null> {
    if (this.isCycleRunning) {
      logger.debug('[model-discovery-scheduler] Cycle already running, skipping');
      return null;
    }
    this.isCycleRunning = true;

    try {
      const result = await modelDiscovery.runCycle();

      // Success — reset backoff
      this.consecutiveFailures = 0;
      this.currentInterval = parseInterval();

      modelDiscoveryRunTotal.inc({ result: 'success' });
      logger.info('[model-discovery-scheduler] Cycle succeeded', {
        context: {
          totalCandidates: result.totalCandidates,
          durationMs: result.durationMs,
          providers: result.results.length,
        },
      });

      return result;
    } catch (error) {
      this.consecutiveFailures++;
      // Exponential backoff: double the interval, cap at MAX_INTERVAL_MS
      const backoffInterval = Math.min(
        this.currentInterval * Math.pow(2, this.consecutiveFailures),
        MAX_INTERVAL_MS,
      );
      this.currentInterval = backoffInterval;

      modelDiscoveryRunTotal.inc({ result: 'failure' });
      logger.warn('[model-discovery-scheduler] Cycle failed, applying backoff', {
        context: {
          consecutiveFailures: this.consecutiveFailures,
          nextIntervalMs: this.currentInterval,
        },
        error: error instanceof Error ? error : undefined,
      });

      return null;
    } finally {
      this.isCycleRunning = false;
    }
  }

  private computeJitter(): number {
    const range = this.currentInterval * JITTER_FACTOR;
    return (Math.random() * 2 - 1) * range;
  }

  /** Test helper: get current state. */
  getState(): {
    running: boolean;
    consecutiveFailures: number;
    currentInterval: number;
    startedAt: number;
  } {
    return {
      running: this.running,
      consecutiveFailures: this.consecutiveFailures,
      currentInterval: this.currentInterval,
      startedAt: this.startedAt,
    };
  }

  /** Test helper: reset internal state. */
  reset(): void {
    this.stop();
    this.consecutiveFailures = 0;
    this.currentInterval = parseInterval();
    this.seeded = false;
    this.isCycleRunning = false;
  }
}

export const modelDiscoveryScheduler = new ModelDiscoveryScheduler();
