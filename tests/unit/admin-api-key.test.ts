/**
 * Demanda 10099 — CRIT-1: validação mínima da ADMIN_API_KEY no startup.
 */
import { describe, expect, it } from 'vitest';
import { validateAdminApiKey } from '../../server/utils/admin-api-key';

describe('validateAdminApiKey', () => {
  it('rejeita chave ausente', () => {
    expect(validateAdminApiKey(undefined)).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejeita chave curta (<16 chars)', () => {
    expect(validateAdminApiKey('short_key')).toEqual({ ok: false, reason: 'too_short' });
  });

  it('rejeita placeholders conhecidos', () => {
    expect(validateAdminApiKey('your_admin_api_key_here')).toEqual({
      ok: false,
      reason: 'placeholder',
    });
    // Placeholders curtos (<16 chars) são rejeitados por `too_short` primeiro.
    expect(validateAdminApiKey('change_me')).toEqual({ ok: false, reason: 'too_short' });
    expect(validateAdminApiKey('admin')).toEqual({ ok: false, reason: 'too_short' });
  });

  it('aceita chave com 16+ chars não-placeholder', () => {
    expect(validateAdminApiKey('local_dev_dummy_admin_api_key')).toEqual({ ok: true });
  });
});
