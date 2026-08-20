/**
 * Os segredos da plataforma pública (`JWT_SECRET`, `GIT_TOKEN_SECRET`) assinam a
 * sessão do /vibe, assinam o `state` do OAuth e derivam a chave AES que cifra
 * tokens do GitHub em repouso. Os valores de exemplo estão publicados no
 * repositório, então precisam ser rejeitados na validação.
 */
import { describe, expect, it } from 'vitest';
import { validatePlatformSecret } from '../../server/utils/platform-secrets';

describe('validatePlatformSecret', () => {
  it('rejeita segredo ausente', () => {
    expect(validatePlatformSecret(undefined)).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejeita segredo curto (<16 chars)', () => {
    expect(validatePlatformSecret('curto')).toEqual({ ok: false, reason: 'too_short' });
  });

  it('rejeita os valores publicados no .env.example', () => {
    expect(validatePlatformSecret('change_this_to_a_long_random_dev_only_secret')).toEqual({
      ok: false,
      reason: 'placeholder',
    });
    expect(validatePlatformSecret('change_this_to_a_long_random_dev_only_secret_too')).toEqual({
      ok: false,
      reason: 'placeholder',
    });
  });

  it('aceita segredo forte', () => {
    expect(validatePlatformSecret('Qw8pR2vXm5Lz7Nb1Kd4Yj6Ht0Cs3Ga9F')).toEqual({ ok: true });
  });
});
