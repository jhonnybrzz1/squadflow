import { resolvePath } from '@shared/utils/paths';
import { eventBus, type DocumentGenerationPayload } from '../events/event-bus';
import { documentJobsService } from '../services/document-jobs';
import { pdfGenerator } from '../services/pdf-generator';
import { logger } from '../utils/logger';
import { withRetryAndDlq, getWorkerRetryConfig } from '../services/retry-with-dlq';
import fs from 'fs';
import path from 'path';
import {
  validateIdempotencySchema,
  registerIdempotencyKey,
  recordSuccessfulDialect,
  removeIdempotencyKey,
} from './document-worker-utils';

// ─── Retry util com backoff exponencial e DLQ ───────────────────────────────
async function withDocumentRetry<T>(
  fn: () => Promise<T>,
  payload: DocumentGenerationPayload,
  httpStatus?: number | null,
): Promise<T> {
  const messageId = `pdf_gen_${payload.demandId}_${payload.type}_${Date.now()}`;
  return withRetryAndDlq(fn, getWorkerRetryConfig({ workerName: 'document', httpStatus }), {
    queueName: 'document_generation',
    messageId,
    payload: payload as unknown as Record<string, unknown>,
  });
}

export function initializeDocumentWorker() {
  logger.info('Initializing Document Worker (Event-Driven)');

  eventBus.subscribe<DocumentGenerationPayload>(
    'DOCUMENT_GENERATION_REQUESTED',
    async (payload) => {
      logger.info(`[DocumentWorker] Processing PDF generation for demand ${payload.demandId}`);
      const { demandId, type, content, targetFilepath, jobId } = payload;

      // Spec 015 B2 (H-10): transições duráveis do job (pending→running→final).
      if (jobId) {
        await documentJobsService.markRunning(jobId).catch((err) => {
          // CRIT-18: log em vez de engolir silenciosamente.
          logger.warn('Failed to mark document job as running', {
            error: err instanceof Error ? err : undefined,
            context: { jobId, demandId },
          });
        });
      }

      // Idempotency check: hash based on demandId, type, and current minute
      const currentMinute = Math.floor(Date.now() / 60000);
      const idempotencyKey = `pdf_gen_${demandId}_${type}_${currentMinute}`;

      // Validate schema
      await validateIdempotencySchema();

      // Register idempotency key
      try {
        await registerIdempotencyKey(idempotencyKey);
      } catch (error: unknown) {
        if (error instanceof Error && error.message === 'DUPLICATE_KEY') {
          return; // Skip duplicate generation
        }
        throw error;
      }

      try {
        const pdfContent = await withDocumentRetry(
          async () => {
            if (type === 'PRD') {
              return pdfGenerator.generatePRDDocument(content, demandId);
            } else if (type === 'Tasks') {
              return pdfGenerator.generateTasksDocument(content, demandId);
            } else {
              return pdfGenerator.generatePRDDocument(content, demandId);
            }
          },
          { demandId, type, content, targetFilepath, jobId },
        );

        const resolvedTarget = path.resolve(targetFilepath);
        const documentsDir = resolvePath('documents');
        const tmpDir = path.resolve('/tmp');

        if (!resolvedTarget.startsWith(documentsDir) && !resolvedTarget.startsWith(tmpDir)) {
          throw new Error(
            `Security Violation: Path traversal detected. Target filepath is outside allowed directories: ${targetFilepath}`,
          );
        }

        fs.writeFileSync(resolvedTarget, pdfContent);
        logger.info(`[DocumentWorker] Successfully generated PDF at ${targetFilepath}`);

        // Record successful dialect
        await recordSuccessfulDialect(idempotencyKey);

        if (jobId) {
          await documentJobsService.markSucceeded(jobId).catch((err) => {
            // CRIT-18: log em vez de engolir silenciosamente.
            logger.warn('Failed to mark document job as succeeded', {
              error: err instanceof Error ? err : undefined,
              context: { jobId, demandId },
            });
          });
        }

        eventBus.publish('DOCUMENT_GENERATED', { demandId, filepath: targetFilepath, type });
      } catch (error) {
        logger.error(
          `[DocumentWorker] Failed to generate PDF for demand ${payload.demandId} after retries`,
          {
            error: error instanceof Error ? error : undefined,
          },
        );
        // Remove idempotency key to allow manual retry
        await removeIdempotencyKey(idempotencyKey);
        if (jobId) {
          await documentJobsService
            .markFailed(jobId, error instanceof Error ? error.message : 'unknown_error')
            .catch((err) => {
              // CRIT-18: log em vez de engolir silenciosamente.
              logger.warn('Failed to mark document job as failed', {
                error: err instanceof Error ? err : undefined,
                context: { jobId, demandId },
              });
            });
        }
      }
    },
  );
}
