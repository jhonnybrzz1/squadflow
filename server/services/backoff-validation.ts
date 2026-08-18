import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * A-2: validação defensiva de configuração de backoff no boot.
 * Emite warning se o teto máximo é menor que o backoff base de qualquer worker.
 */
export function validateBackoffConfig(): void {
  const workers = [
    {
      name: 'orchestration',
      base: env.orchestrationBaseBackoffMs,
      max: env.orchestrationMaxBackoffMs,
    },
    { name: 'document', base: env.workerBackoffDocumentMs, max: env.workerMaxBackoffMs },
    { name: 'demand-gen', base: env.workerBackoffDemandGenMs, max: env.workerMaxBackoffMs },
  ];

  for (const worker of workers) {
    if (worker.max < worker.base) {
      logger.warn('A-2: worker MAX_BACKOFF_MS menor que base', {
        context: {
          worker_name: worker.name,
          base_backoff_ms: worker.base,
          max_backoff_ms: worker.max,
          timestamp: new Date().toISOString(),
        },
      });
    }
  }
}
