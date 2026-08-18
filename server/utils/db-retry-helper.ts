import { logger } from './logger';

/**
 * Executes a database insert function with exponential backoff retry logic.
 * Guaranteed never to throw an exception; failures are logged as warnings.
 */
export async function resilientInsert(
  op: string,
  insertFn: () => Promise<unknown>,
  options: { maxRetries?: number; baseBackoffMs?: number } = {},
): Promise<void> {
  const maxRetries = options.maxRetries ?? 3;
  const baseBackoffMs = options.baseBackoffMs ?? 100;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await insertFn();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = baseBackoffMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  logger.warn(
    `[resilientInsert] escrita '${op}' falhou após ${maxRetries + 1} tentativas (fail-open)`,
    {
      error: lastError instanceof Error ? lastError : undefined,
      context: { op, attempts: maxRetries + 1 },
    },
  );
}
