import { describe, it, expect } from 'vitest';
import { timingSafeStringEqual, isValidToken } from '../../server/utils/timing-safe-compare';

describe('timing-safe-compare (H-2)', () => {
  describe('timingSafeStringEqual', () => {
    it('returns true for equal strings', () => {
      expect(timingSafeStringEqual('secret-token', 'secret-token')).toBe(true);
    });

    it('returns false for different strings of same length', () => {
      expect(timingSafeStringEqual('secret-token', 'secret-tokem')).toBe(false);
    });

    it('returns false for different lengths without throwing', () => {
      expect(timingSafeStringEqual('short', 'much-longer-string')).toBe(false);
      expect(timingSafeStringEqual('much-longer-string', 'short')).toBe(false);
    });

    it('returns false for empty strings', () => {
      expect(timingSafeStringEqual('', '')).toBe(true); // equal empties
      expect(timingSafeStringEqual('a', '')).toBe(false);
    });

    it('handles unicode correctly', () => {
      expect(timingSafeStringEqual('tökën', 'tökën')).toBe(true);
      expect(timingSafeStringEqual('tökën', 'token')).toBe(false);
    });
  });

  describe('isValidToken', () => {
    it('returns true when provided matches expected', () => {
      expect(isValidToken('my-token', 'my-token')).toBe(true);
    });

    it('returns false when provided does not match', () => {
      expect(isValidToken('wrong', 'my-token')).toBe(false);
    });

    it('returns false when provided is undefined', () => {
      expect(isValidToken(undefined, 'my-token')).toBe(false);
    });

    it('returns false when expected is empty (no auth bypass)', () => {
      expect(isValidToken('anything', '')).toBe(false);
      expect(isValidToken('', '')).toBe(false);
    });

    it('returns false when provided is empty', () => {
      expect(isValidToken('', 'my-token')).toBe(false);
    });
  });
});
