import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { describe, expect, it, vi } from 'vitest';

/**
 * Política de retry do cliente GitHub.
 *
 * Com um token expirado, cada chamada à API virava 4 requisições 401 (~2s) e
 * queimava 4x do rate limit — retentar credencial inválida nunca vai dar certo.
 *
 * A causa é sutil: `doNotRetry` do plugin já inclui 401, mas quem decide o
 * retry no fim é o handler `failed` do Bottleneck, que só lê
 * `error.request.request.retries` sem reconsultar `doNotRetry`. Esse campo é
 * normalmente gravado pelo próprio plugin apenas em erros retentáveis — só que
 * passar `request: { retries: n }` na criação do cliente o preenche em toda
 * request, inclusive nas que deveriam falhar de imediato.
 *
 * Estes testes fixam o comportamento contando requisições de verdade.
 */

const MyOctokit = Octokit.plugin(retry, throttling);

function makeFetch(status: number) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ message: 'Bad credentials' }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

const throttleNoop = {
  onRateLimit: () => false,
  onSecondaryRateLimit: () => false,
};

describe('política de retry do cliente GitHub', () => {
  it('não retenta 401 — credencial inválida não melhora com nova tentativa', async () => {
    const fetchMock = makeFetch(401);
    const client = new MyOctokit({
      auth: 'token-invalido',
      request: { fetch: fetchMock },
      retry: { retries: 3 },
      throttle: throttleNoop,
    });

    await expect(client.rest.users.getAuthenticated()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404])('não retenta %i', async (status) => {
    const fetchMock = makeFetch(status);
    const client = new MyOctokit({
      auth: 'token',
      request: { fetch: fetchMock },
      retry: { retries: 3 },
      throttle: throttleNoop,
    });

    await expect(client.rest.users.getAuthenticated()).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('demonstra a regressão: `retries` dentro de `request` faz o 401 ser retentado', async () => {
    const fetchMock = makeFetch(401);
    const client = new MyOctokit({
      auth: 'token-invalido',
      // Config antiga — é exatamente isto que este teste existe para impedir.
      request: { fetch: fetchMock, retries: 3 },
      throttle: throttleNoop,
    });

    await expect(client.rest.users.getAuthenticated()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('continua retentando falha transitória de servidor (500)', async () => {
    const fetchMock = makeFetch(500);
    const client = new MyOctokit({
      auth: 'token',
      request: { fetch: fetchMock },
      retry: { retries: 2, retryAfterBaseValue: 1 },
      throttle: throttleNoop,
    });

    await expect(client.rest.users.getAuthenticated()).rejects.toMatchObject({ status: 500 });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});
