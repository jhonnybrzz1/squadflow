/**
 * Timing-safe string comparison utility.
 *
 * H-2: `===` on secrets (auth tokens, API keys) is vulnerable to timing
 * attacks — the comparison short-circuits on the first differing byte,
 * leaking how many leading bytes match. `crypto.timingSafeEqual` runs in
 * constant time but requires equal-length Buffers, so we handle the
 * length-mismatch case without leaking length info (return false immediately,
 * but still do a dummy comparison to keep the call count constant).
 */
import { timingSafeEqual } from 'crypto';

/**
 * Compares two strings in constant time. Returns true iff they are equal.
 * Does NOT leak length information: when lengths differ, a dummy comparison
 * against a same-length buffer is still performed so the timing is
 * indistinguishable from the equal-length case.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  if (bufA.length !== bufB.length) {
    // Still perform a comparison to keep timing constant — compare bufA
    // against itself so the call count and rough duration match the
    // equal-length path. The result is discarded.
    timingSafeEqual(bufA, bufA);
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

/**
 * Checks whether a provided token matches the expected secret using
 * timing-safe comparison. Returns false if either value is empty (never
 * allow empty-string auth bypass).
 */
export function isValidToken(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  return timingSafeStringEqual(provided, expected);
}
