/**
 * Erro estruturado lançado pela camada de API do cliente.
 *
 * Preserva `status`, `errorCode`, `retryAfter` e `requestId` do contrato
 * ErrorResponse do backend para que `getFriendlyError` traduza a falha em
 * mensagem amigável sem depender de parsing do texto bruto. A `message`
 * mantém o formato legado `"<status>: <texto>"` para compatibilidade.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly errorCode?: string;
  readonly retryAfter?: number;
  readonly requestId?: string;
  readonly body?: unknown;

  constructor(
    message: string,
    options: {
      status: number;
      errorCode?: string;
      retryAfter?: number;
      requestId?: string;
      body?: unknown;
    },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.errorCode = options.errorCode;
    this.retryAfter = options.retryAfter;
    this.requestId = options.requestId;
    this.body = options.body;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

/**
 * Constrói um ApiError a partir de uma Response HTTP não-ok, extraindo
 * `errorCode`/`requestId` do corpo (contrato ErrorResponse) e `retryAfter`
 * do header `Retry-After` quando presentes.
 */
export async function apiErrorFromResponse(res: Response): Promise<ApiError> {
  const text = (await res.text()) || res.statusText;

  let errorCode: string | undefined;
  let requestId: string | undefined;
  let body: unknown;
  try {
    body = JSON.parse(text);
    if (body && typeof body === 'object') {
      const parsed = body as { errorCode?: unknown; requestId?: unknown };
      if (typeof parsed.errorCode === 'string') errorCode = parsed.errorCode;
      if (typeof parsed.requestId === 'string') requestId = parsed.requestId;
    }
  } catch (_) {
    // corpo não-JSON: mantém apenas status/texto
  }

  const retryAfterHeader = res.headers.get('Retry-After');
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;

  return new ApiError(`${res.status}: ${text}`, {
    status: res.status,
    errorCode,
    retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
    requestId,
    body,
  });
}
