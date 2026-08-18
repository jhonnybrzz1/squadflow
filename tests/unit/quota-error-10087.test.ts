/**
 * Demanda 10087 — quota do provedor (429/402) tratada como classe própria e
 * traduzida para mensagem específica no frontend.
 */
import { describe, it, expect } from 'vitest';
import { QuotaExceededError } from '../../server/services/llm-completion-service';
import { getFriendlyError } from '../../client/src/lib/friendly-error';

describe('QuotaExceededError (CA1/CA5)', () => {
  it('carrega provider, status e o marcador de telemetria', () => {
    const err = new QuotaExceededError('openrouter', 402);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('QuotaExceededError');
    expect(err.provider).toBe('openrouter');
    expect(err.status).toBe(402);
    expect(err.providerQuotaExceeded).toBe(true);
    expect(err.message).toContain('openrouter');
  });
});

describe('mensagem de quota no frontend (CA4)', () => {
  it('402 vira "Limite do provedor atingido"', () => {
    const entry = getFriendlyError({ status: 402 });
    expect(entry.errorCode).toBe('PROVIDER_QUOTA_EXCEEDED');
    expect(entry.message).toContain('tente outro modelo');
  });

  it('429 continua sendo rate limit do app (não é quota de provedor)', () => {
    expect(getFriendlyError({ status: 429 }).errorCode).toBe('RATE_LIMIT_EXCEEDED');
  });
});
