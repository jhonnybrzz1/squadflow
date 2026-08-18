import { env } from '../config/env';
import { logger } from '../utils/logger';
import { dlqService } from './dlq-service';

export interface RetryWithDlqConfig {
  maxAttempts: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

export interface RetryWithDlqOptions {
  queueName: string;
  messageId: string;
  payload: Record<string, unknown>;
}

export function getEnvRetryConfig(): RetryWithDlqConfig {
  return {
    maxAttempts: env.retryMaxAttempts,
    initialDelayMs: env.retryInitialDelayMs,
    backoffMultiplier: env.retryBackoffMultiplier,
    maxDelayMs: env.retryMaxDelayMs,
  };
}

/**
 * A-2: configuração de retry para workers, com backoff base por worker,
 * maxRetries e teto. Mantém compatibilidade com defaults seguros.
 */
export interface WorkerRetryConfig {
  workerName: 'document' | 'demand-gen';
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  httpStatus?: number | null;
}

export function getWorkerRetryConfig(config: WorkerRetryConfig): RetryWithDlqConfig {
  const base =
    config.baseBackoffMs ??
    (config.workerName === 'document' ? env.workerBackoffDocumentMs : env.workerBackoffDemandGenMs);
  const maxAttempts = config.maxAttempts ?? env.workerMaxRetries;
  const maxDelayMs = config.maxBackoffMs ?? env.workerMaxBackoffMs;

  return {
    maxAttempts,
    initialDelayMs: base,
    backoffMultiplier: 2,
    maxDelayMs,
    onRetry(attempt: number, delayMs: number, error: unknown) {
      const status =
        typeof error === 'object' && error !== null && 'status' in error
          ? (error as { status?: number }).status
          : null;
      logger.warn('A-2: worker retry backoff aplicado', {
        error: error instanceof Error ? error : undefined,
        context: {
          worker_name: config.workerName,
          http_status: config.httpStatus ?? status ?? null,
          attempt,
          delay_applied: delayMs,
          base_backoff_ms: base,
          max_backoff_ms: maxDelayMs,
          timestamp: new Date().toISOString(),
        },
      });
    },
  };
}

function resolveDelay(config: RetryWithDlqConfig, attempt: number): number {
  const raw = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
  return Math.min(raw, config.maxDelayMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executa uma função com retry exponencial configurável. Se todas as tentativas
 * falharem, a mensagem é enviada para a DLQ persistente.
 *
 * @param fn Função a ser executada.
 * @param retryConfig Configuração de retry.
 * @param dlqOptions Metadados para a DLQ.
 */
export async function withRetryAndDlq<T>(
  fn: () => Promise<T>,
  retryConfig: RetryWithDlqConfig = getEnvRetryConfig(),
  dlqOptions: RetryWithDlqOptions,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === retryConfig.maxAttempts) {
        break;
      }

      const delayMs = resolveDelay(retryConfig, attempt);
      logger.warn(
        `Retry attempt ${attempt}/${retryConfig.maxAttempts} falhou; próxima em ${delayMs}ms`,
        {
          error: error instanceof Error ? error : undefined,
          context: {
            queueName: dlqOptions.queueName,
            messageId: dlqOptions.messageId,
            attempt,
            nextAttempt: attempt + 1,
            delayMs,
          },
        },
      );

      if (retryConfig.onRetry) {
        retryConfig.onRetry(attempt, delayMs, error);
      }

      await sleep(delayMs);
    }
  }

  const stackTrace =
    lastError instanceof Error ? (lastError.stack ?? lastError.message) : String(lastError);
  logger.error(`Retry esgotado após ${retryConfig.maxAttempts} tentativas; movendo para DLQ`, {
    error: lastError instanceof Error ? lastError : undefined,
    context: {
      queueName: dlqOptions.queueName,
      messageId: dlqOptions.messageId,
    },
  });

  await dlqService.sendToDlq({
    messageId: dlqOptions.messageId,
    queueName: dlqOptions.queueName,
    payload: dlqOptions.payload,
    stackTrace,
    retryCount: retryConfig.maxAttempts,
  });

  throw lastError;
}
