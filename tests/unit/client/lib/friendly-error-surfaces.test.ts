/**
 * SC-002/SC-003: para cada errorCode do contrato, a superfície de erro do
 * cliente (ApiError → getFriendlyErrorFromException) produz mensagem amigável
 * em PT-BR, sem stack trace, nome de serviço interno ou payload bruto; e o
 * UniversalErrorFallback compartilha os mesmos textos por categoria (US3).
 */
import { describe, it, expect } from 'vitest';
import { ApiError, apiErrorFromResponse } from '../../../../client/src/lib/api-error';
import {
  getFriendlyError,
  getFriendlyErrorFromException,
  CATEGORY_TEXTS,
} from '../../../../client/src/lib/friendly-error';

const SUPPORTED_CODES = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'CONFLICT',
  'RATE_LIMIT_EXCEEDED',
  'EXTERNAL_SERVICE_ERROR',
  'INTERNAL_ERROR',
] as const;

describe('superfícies de erro (toast) com ApiError', () => {
  it.each(SUPPORTED_CODES)('%s → mensagem amigável sem conteúdo técnico', (errorCode) => {
    const raw = new ApiError(`500: {"errorCode":"${errorCode}","stack":"at foo.ts:1"}`, {
      status: 500,
      errorCode,
    });
    const friendly = getFriendlyErrorFromException(raw);

    expect(friendly.errorCode).toBe(errorCode);
    // Nunca vaza o texto bruto do backend nem jargão interno
    expect(friendly.message).not.toContain('stack');
    expect(friendly.message).not.toContain('foo.ts');
    expect(friendly.message).not.toMatch(/OpenRouter|Bedrock|GitHub API|Zod|payload|errorCode/i);
    // Sempre PT-BR com orientação
    expect(friendly.message.length).toBeGreaterThan(10);
    expect(friendly.title.length).toBeGreaterThan(0);
  });

  it('apiErrorFromResponse extrai errorCode, requestId e Retry-After do contrato', async () => {
    const res = new Response(
      JSON.stringify({
        error: 'RateLimitError',
        errorCode: 'RATE_LIMIT_EXCEEDED',
        message: 'Rate limit exceeded',
        statusCode: 429,
        requestId: 'req-42',
      }),
      { status: 429, headers: { 'Retry-After': '30', 'Content-Type': 'application/json' } },
    );

    const err = await apiErrorFromResponse(res);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.errorCode).toBe('RATE_LIMIT_EXCEEDED');
    expect(err.requestId).toBe('req-42');
    expect(err.retryAfter).toBe(30);

    const friendly = getFriendlyErrorFromException(err);
    expect(friendly.message).toContain('30 segundos');
    expect(friendly.action).toBe('wait');
  });

  it('resposta não-JSON (HTML de proxy) cai no mapeamento por status', async () => {
    const res = new Response('<html>Bad Gateway</html>', { status: 502 });
    const err = await apiErrorFromResponse(res);
    expect(err.errorCode).toBeUndefined();
    expect(getFriendlyErrorFromException(err).errorCode).toBe('EXTERNAL_SERVICE_ERROR');
  });

  it('mensagem legada "status: texto" é preservada para compatibilidade', async () => {
    const res = new Response('Internal server error', { status: 500 });
    const err = await apiErrorFromResponse(res);
    expect(err.message).toBe('500: Internal server error');
  });
});

describe('consistência toast × UniversalErrorFallback (US3)', () => {
  it('INTERNAL_ERROR usa exatamente o texto da categoria system', () => {
    const entry = getFriendlyError({ errorCode: 'INTERNAL_ERROR' });
    expect(entry.title).toBe(CATEGORY_TEXTS.system.title);
    expect(entry.message).toBe(CATEGORY_TEXTS.system.message);
  });

  it('UNKNOWN usa exatamente o texto da categoria unknown', () => {
    const entry = getFriendlyError({});
    expect(entry.title).toBe(CATEGORY_TEXTS.unknown.title);
    expect(entry.message).toBe(CATEGORY_TEXTS.unknown.message);
  });

  it('toda categoria usada pelos errorCodes existe em CATEGORY_TEXTS', () => {
    for (const code of SUPPORTED_CODES) {
      const entry = getFriendlyError({ errorCode: code });
      expect(CATEGORY_TEXTS[entry.category]).toBeDefined();
    }
  });
});
