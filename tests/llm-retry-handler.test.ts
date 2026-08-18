import { describe, it, expect } from 'vitest';
import {
  isRetryableError,
  getErrorStatus,
  getHeaderValue,
  getRetryAfterDelayMs,
  redactSensitiveText,
  getErrorMessage,
  getRequestId,
  parsePositiveInt,
  sleep,
} from '../server/services/llm-retry-handler';

describe('llm-retry-handler', () => {
  describe('isRetryableError', () => {
    it('returns true for timeout errors', () => {
      const error = new Error('ETIMEDOUT');
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for connection refused errors', () => {
      const error = new Error('ECONNREFUSED');
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for 429 rate limit errors', () => {
      const error = new Error('Rate limited');
      (error as any).status = 429;
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for 5xx server errors', () => {
      const error = new Error('Server error');
      (error as any).status = 500;
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns false for 4xx client errors (except 429)', () => {
      const error = new Error('Bad request');
      (error as any).status = 400;
      expect(isRetryableError(error)).toBe(false);
    });
  });

  describe('getErrorStatus', () => {
    it('extracts status from error object', () => {
      const error = { status: 404 };
      expect(getErrorStatus(error)).toBe(404);
    });

    it('extracts status from nested response', () => {
      const error = { response: { status: 500 } };
      expect(getErrorStatus(error)).toBe(500);
    });

    it('returns undefined for errors without status', () => {
      const error = { message: 'Something went wrong' };
      expect(getErrorStatus(error)).toBeUndefined();
    });
  });

  describe('getHeaderValue', () => {
    it('extracts header from error object (plain object)', () => {
      const error = { headers: { 'retry-after': '60' } };
      expect(getHeaderValue(error, 'retry-after')).toBe('60');
    });

    it('performs case-insensitive lookup', () => {
      const error = { headers: { 'Retry-After': '45' } };
      expect(getHeaderValue(error, 'retry-after')).toBe('45');
    });

    it('returns undefined for missing headers', () => {
      const error = { headers: {} };
      expect(getHeaderValue(error, 'retry-after')).toBeUndefined();
    });
  });

  describe('getRetryAfterDelayMs', () => {
    it('converts seconds to milliseconds', () => {
      const error = { headers: { 'retry-after': '60' } };
      expect(getRetryAfterDelayMs(error)).toBe(60000);
    });

    it('returns null for missing header', () => {
      const error = { headers: {} };
      expect(getRetryAfterDelayMs(error)).toBeNull();
    });
  });

  describe('redactSensitiveText', () => {
    it('redacts API keys', () => {
      const result = redactSensitiveText('key: sk-abc123def4567890123456'); // gitleaks:allow -- synthetic redaction fixture
      expect(result).toContain('<redacted>');
      expect(result).not.toContain('sk-abc');
    });

    it('redacts Bearer tokens', () => {
      const result = redactSensitiveText('Authorization: Bearer abc123def456');
      expect(result).toContain('Bearer <redacted>');
    });
  });

  describe('getErrorMessage', () => {
    it('extracts message from Error object', () => {
      const error = new Error('Something failed');
      expect(getErrorMessage(error)).toContain('failed');
    });

    it('redacts sensitive information', () => {
      const error = new Error('Failed with key sk-abc123def4567890123456');
      const result = getErrorMessage(error);
      expect(result).toContain('<redacted>');
      expect(result).not.toContain('sk-abc');
    });

    it('handles string errors', () => {
      expect(getErrorMessage('String error')).toContain('String error');
    });

    it('returns default message for unknown errors', () => {
      expect(getErrorMessage(null)).toBe('AI request failed');
    });
  });

  describe('getRequestId', () => {
    it('extracts request_id from error', () => {
      const error = { request_id: 'req-123' };
      expect(getRequestId(error)).toBe('req-123');
    });

    it('extracts from x-request-id header', () => {
      const error = {
        headers: { get: (key: string) => (key === 'x-request-id' ? 'req-456' : null) },
      };
      expect(getRequestId(error)).toBe('req-456');
    });

    it('returns undefined for missing request ID', () => {
      expect(getRequestId({})).toBeUndefined();
    });
  });

  describe('parsePositiveInt', () => {
    it('parses valid positive integers', () => {
      expect(parsePositiveInt('42', 10)).toBe(42);
    });

    it('returns fallback for invalid strings', () => {
      expect(parsePositiveInt('abc', 10)).toBe(10);
    });

    it('returns fallback for zero or negative', () => {
      expect(parsePositiveInt('0', 10)).toBe(10);
      expect(parsePositiveInt('-5', 10)).toBe(10);
    });
  });

  describe('sleep', () => {
    it('resolves after specified delay', async () => {
      const start = Date.now();
      await sleep(100);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(150);
    });
  });
});
