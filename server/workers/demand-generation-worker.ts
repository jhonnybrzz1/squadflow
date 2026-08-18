import type { ChatMessage } from '@shared/schema';

import { demandRepository } from '../repositories/demand-repository';
import { aiSquadService } from '../services/ai-squad';
import {
  demandGenerationJobsService,
  type DemandGenerationJob,
} from '../services/demand-generation-jobs';
import { sseManager } from '../services/sse';
import { logger } from '../utils/logger';
import { env } from '../config/env';

const queue: DemandGenerationJob[] = [];
let draining: Promise<void> | null = null;

function calculateBackoffDelay(attempt: number): number {
  const base = env.workerBackoffDemandGenMs;
  const delay = Math.min(base * 2 ** attempt, env.workerMaxBackoffMs);
  return delay;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function forwardProgressIfActive(demandId: number, message: ChatMessage): Promise<void> {
  if (aiSquadService.isStopRequested(demandId)) return;

  const current = await demandRepository.findByIdOrNull(demandId);
  if (!current || current.status !== 'processing') return;

  await demandRepository.update(demandId, {
    status: 'processing',
    progress: message.progress || current.progress || 0,
  });

  sseManager.sendProgress(demandId, message.progress || 0, {
    agent: message.agent,
    message: message.message,
    timestamp: message.timestamp,
    type: message.type,
    metadata: message.metadata,
  });
}

export function enqueueDemandGenerationJob(job: DemandGenerationJob): void {
  queue.push(job);
  if (!draining) {
    draining = drain().finally(() => {
      draining = null;
    });
  }
}

async function runDemandGenerationJob(job: DemandGenerationJob): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < env.workerMaxRetries; attempt++) {
    try {
      await demandGenerationJobsService.markRunning(job.id);
      await aiSquadService.processDemandRoundtable(job.demandId, job.config, async (message) => {
        await forwardProgressIfActive(job.demandId, message);
      });
      await demandGenerationJobsService.markSucceeded(job.id);
      return;
    } catch (error) {
      lastError = error;
      const isCooldownError =
        error instanceof Error && error.message.includes('reprocessamento bloqueado por');

      if (isCooldownError) {
        logger.warn('Circuit breaker cooldown ativo — interrompendo retries imediatos do worker', {
          context: { jobId: job.id, demandId: job.demandId, attempt },
        });
        break;
      }

      const httpStatus =
        typeof error === 'object' && error !== null && 'status' in error
          ? (error as { status?: number }).status
          : null;

      if (attempt < env.workerMaxRetries - 1) {
        const delay = calculateBackoffDelay(attempt);
        logger.warn('A-2: demand-generation worker backoff aplicado', {
          error: error instanceof Error ? error : undefined,
          context: {
            worker_name: 'demand-generation',
            http_status: httpStatus,
            attempt,
            delay_applied: delay,
            base_backoff_ms: env.workerBackoffDemandGenMs,
            max_backoff_ms: env.workerMaxBackoffMs,
            timestamp: new Date().toISOString(),
          },
        });
        await sleep(delay);
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'unknown_error';
  await demandGenerationJobsService.markFailed(job.id, message);
  logger.error('Demand generation job failed after retries', {
    error: lastError instanceof Error ? lastError : undefined,
    context: { jobId: job.id, demandId: job.demandId, attempts: env.workerMaxRetries },
  });
}

async function drain(): Promise<void> {
  while (queue.length > 0) {
    const job = queue.shift();
    if (!job) continue;
    await runDemandGenerationJob(job);
  }
}

export async function recoverDemandGenerationJobsOnStartup(): Promise<number> {
  const jobs = await demandGenerationJobsService.recoverOnStartup();
  jobs.forEach(enqueueDemandGenerationJob);
  return jobs.length;
}

export async function whenDemandGenerationWorkerIdle(): Promise<void> {
  await draining;
}
