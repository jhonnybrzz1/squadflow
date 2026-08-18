import { z } from 'zod';
import { parsePositiveInt } from './llm-retry-handler';

const DEFAULT_BATCH_CONCURRENCY = 4;
const MAX_BATCH_CONCURRENCY = 10;

/**
 * Parses JSON content safely.
 *
 * @param content - JSON string to parse
 * @returns Parsed object
 * @throws Error if JSON is invalid
 */
export function parseJSONContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Failed to parse AI JSON response: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Validates JSON content against a Zod schema.
 *
 * @param content - JSON string to validate
 * @param schema - Zod schema to validate against
 * @returns Validated data
 * @throws Error if validation fails
 */
export function validateJSONContent<T>(content: string, schema: z.ZodSchema<T>): T {
  const parsed = parseJSONContent(content);
  const result = schema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    throw new Error(`AI JSON response failed schema validation: ${issues}`);
  }

  return result.data;
}

/**
 * Resolves concurrency value with bounds checking.
 *
 * @param value - User-provided concurrency value
 * @returns Resolved concurrency value
 */
export function resolveConcurrency(value: number | undefined): number {
  const parsed =
    value ?? parsePositiveInt(process.env.OPENAI_BATCH_CONCURRENCY, DEFAULT_BATCH_CONCURRENCY);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_BATCH_CONCURRENCY;
  }

  return Math.max(1, Math.min(MAX_BATCH_CONCURRENCY, Math.floor(parsed)));
}

/**
 * Maps an array asynchronously with concurrency control using workers.
 *
 * @param items - Items to map
 * @param concurrency - Maximum concurrent operations
 * @param worker - Async worker function
 * @returns Array of mapped results
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}
