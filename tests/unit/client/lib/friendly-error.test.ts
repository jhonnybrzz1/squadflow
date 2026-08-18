import { describe, it, expect } from 'vitest';
import {
  getFriendlyError,
  getFriendlyErrorFromException,
  CATEGORY_TEXTS,
} from '../../../../client/src/lib/friendly-error';

describe('getFriendlyError', () => {
  it.each([
    ['VALIDATION_ERROR', 'review', 'validation'],
    ['NOT_FOUND', 'review', 'unknown'],
    ['UNAUTHORIZED', 'review', 'system'],
    ['FORBIDDEN', 'review', 'system'],
    ['CONFLICT', 'review', 'validation'],
    ['RATE_LIMIT_EXCEEDED', 'wait', 'unavailable'],
    ['EXTERNAL_SERVICE_ERROR', 'retry', 'unavailable'],
    ['INTERNAL_ERROR', 'retry', 'system'],
    ['NETWORK_ERROR', 'retry', 'unavailable'],
    ['TIMEOUT', 'retry', 'unavailable'],
  ] as const)('%s → action=%s, category=%s', (code, action, category) => {
    const entry = getFriendlyError({ errorCode: code });
    expect(entry.errorCode).toBe(code);
    expect(entry.action).toBe(action);
    expect(entry.category).toBe(category);
    expect(entry.title.length).toBeGreaterThan(0);
    expect(entry.message.length).toBeGreaterThan(0);
  });

  it('é determinística: mesmo errorCode produz sempre a mesma mensagem', () => {
    const a = getFriendlyError({ errorCode: 'VALIDATION_ERROR' });
    const b = getFriendlyError({ errorCode: 'VALIDATION_ERROR' });
    expect(a).toEqual(b);
  });

  it.each([
    [400, 'VALIDATION_ERROR'],
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [422, 'VALIDATION_ERROR'],
    [429, 'RATE_LIMIT_EXCEEDED'],
    [500, 'INTERNAL_ERROR'],
    [502, 'EXTERNAL_SERVICE_ERROR'],
    [503, 'EXTERNAL_SERVICE_ERROR'],
    [504, 'TIMEOUT'],
  ])('status %i → %s quando errorCode ausente', (status, expected) => {
    expect(getFriendlyError({ status }).errorCode).toBe(expected);
  });

  it('fallback UNKNOWN para código desconhecido ou entrada vazia', () => {
    expect(getFriendlyError({ errorCode: 'NO_SUCH_CODE' }).errorCode).toBe('UNKNOWN');
    expect(getFriendlyError({}).errorCode).toBe('UNKNOWN');
    expect(getFriendlyError({}).message).toBe(CATEGORY_TEXTS.unknown.message);
  });

  it('inclui o tempo de espera na mensagem de rate limit com retryAfter', () => {
    const entry = getFriendlyError({ errorCode: 'RATE_LIMIT_EXCEEDED', retryAfter: 30 });
    expect(entry.message).toContain('30 segundos');
    const minutes = getFriendlyError({ errorCode: 'RATE_LIMIT_EXCEEDED', retryAfter: 180 });
    expect(minutes.message).toContain('3 minutos');
  });

  it('nunca expõe jargão técnico nas mensagens', () => {
    const codes = ['VALIDATION_ERROR', 'EXTERNAL_SERVICE_ERROR', 'INTERNAL_ERROR', 'UNKNOWN'];
    for (const errorCode of codes) {
      const entry = getFriendlyError({ errorCode });
      expect(entry.message).not.toMatch(/stack|trace|OpenRouter|GitHub|Bedrock|Zod|payload/i);
    }
  });
});

describe('getFriendlyErrorFromException', () => {
  it('usa errorCode do ApiError quando presente', () => {
    const err = Object.assign(new Error('500: raw backend text'), {
      status: 429,
      errorCode: 'RATE_LIMIT_EXCEEDED',
      retryAfter: 15,
    });
    const entry = getFriendlyErrorFromException(err);
    expect(entry.errorCode).toBe('RATE_LIMIT_EXCEEDED');
    expect(entry.message).toContain('15 segundos');
  });

  it('mapeia por status quando errorCode ausente', () => {
    const err = Object.assign(new Error('404: Not Found'), { status: 404 });
    expect(getFriendlyErrorFromException(err).errorCode).toBe('NOT_FOUND');
  });

  it('detecta timeout e falha de rede por mensagem', () => {
    expect(getFriendlyErrorFromException(new Error('timeout after 8000ms')).errorCode).toBe(
      'TIMEOUT',
    );
    expect(getFriendlyErrorFromException(new TypeError('Failed to fetch')).errorCode).toBe(
      'NETWORK_ERROR',
    );
  });

  it('fallback UNKNOWN para valores não-Error', () => {
    expect(getFriendlyErrorFromException(undefined).errorCode).toBe('UNKNOWN');
    expect(getFriendlyErrorFromException('boom').errorCode).toBe('UNKNOWN');
  });
});
