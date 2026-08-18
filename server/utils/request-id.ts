import { randomUUID } from 'crypto';

/**
 * Generates a unique request ID for tracking AI requests.
 * Uses UUID v4 for uniqueness and standardization.
 *
 * @returns A UUID v4 string
 *
 * @example
 * ```typescript
 * const requestId = generateRequestId();
 * console.log(requestId); // "550e8400-e29b-41d4-a716-446655440000"
 * ```
 */
export function generateRequestId(): string {
  return randomUUID();
}

/**
 * Validates if a string is a valid UUID v4.
 *
 * @param requestId The request ID to validate
 * @returns True if valid UUID v4, false otherwise
 */
export function isValidRequestId(requestId: string): boolean {
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidV4Regex.test(requestId);
}
