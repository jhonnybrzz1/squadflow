import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { verifyAdminApiKey } from '../../server/utils/admin-api-key';

describe('verifyAdminApiKey', () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = 'chave-admin-segura-16';
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  it('rejects when ADMIN_API_KEY is not configured', () => {
    delete process.env.ADMIN_API_KEY;
    expect(verifyAdminApiKey('Bearer chave-admin-segura-16')).toBe(false);
  });

  it('rejects missing header', () => {
    expect(verifyAdminApiKey(undefined)).toBe(false);
    expect(verifyAdminApiKey('')).toBe(false);
  });

  it('rejects when header does not use Bearer scheme', () => {
    expect(verifyAdminApiKey('chave-admin-segura-16')).toBe(false);
  });

  it('rejects key shorter than 16 chars', () => {
    process.env.ADMIN_API_KEY = 'curta';
    expect(verifyAdminApiKey('Bearer curta')).toBe(false);
  });

  it('accepts correct Bearer key', () => {
    expect(verifyAdminApiKey('Bearer chave-admin-segura-16')).toBe(true);
  });

  it('rejects incorrect key of same length', () => {
    expect(verifyAdminApiKey('Bearer chave-admin-errada-16')).toBe(false);
  });

  it('trims whitespace from configured key', () => {
    process.env.ADMIN_API_KEY = '  chave-admin-segura-16  ';
    expect(verifyAdminApiKey('Bearer chave-admin-segura-16')).toBe(true);
  });
});
