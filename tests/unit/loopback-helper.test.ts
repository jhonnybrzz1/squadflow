import { describe, it, expect } from 'vitest';
import { isLoopbackAddress } from '../../server/utils/loopback';

describe('isLoopbackAddress', () => {
  it('returns true for IPv4 loopback', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.1.2.3')).toBe(true);
  });

  it('returns true for IPv6 loopback variants', () => {
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::127.0.0.1')).toBe(true);
  });

  it('returns true for localhost hostname', () => {
    expect(isLoopbackAddress('localhost')).toBe(true);
  });

  it('returns false for non-loopback addresses', () => {
    expect(isLoopbackAddress('0.0.0.0')).toBe(false);
    expect(isLoopbackAddress('::')).toBe(false);
    expect(isLoopbackAddress('192.168.1.1')).toBe(false);
    expect(isLoopbackAddress('8.8.8.8')).toBe(false);
    expect(isLoopbackAddress('example.com')).toBe(false);
  });

  it('returns false for null/undefined/empty', () => {
    expect(isLoopbackAddress(null)).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });
});
