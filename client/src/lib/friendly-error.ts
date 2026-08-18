/**
 * Tradução centralizada de erros de API para mensagens amigáveis em PT-BR.
 *
 * Única fonte de verdade para textos de erro exibidos ao usuário — usada
 * tanto por toasts pontuais quanto pelo UniversalErrorFallback.
 * Contrato: specs/005-friendly-error-responses/contracts/error-response-contract.md
 */

export type FriendlyErrorAction = 'retry' | 'wait' | 'review' | 'contact-support';

export type FriendlyErrorCategory = 'system' | 'unavailable' | 'validation' | 'route' | 'unknown';

export interface FriendlyErrorEntry {
  errorCode: string;
  title: string;
  message: string;
  action: FriendlyErrorAction;
  category: FriendlyErrorCategory;
}

export interface FriendlyErrorInput {
  errorCode?: string;
  status?: number;
  /** Segundos até poder tentar de novo (header Retry-After / RateLimitError). */
  retryAfter?: number;
}

/**
 * Textos por categoria compartilhados com UniversalErrorFallback.
 * Mantidos aqui para evitar copy duplicada/divergente entre toast e fallback.
 */
export const CATEGORY_TEXTS: Record<FriendlyErrorCategory, { title: string; message: string }> = {
  system: {
    title: 'Erro do sistema',
    message: 'Ocorreu um erro inesperado ao processar sua solicitação. Por favor, tente novamente.',
  },
  unavailable: {
    title: 'Serviço temporariamente indisponível',
    message:
      'O serviço está temporariamente indisponível. Por favor, aguarde alguns instantes e tente novamente.',
  },
  validation: {
    title: 'Erro de validação',
    message: 'Alguns dados não puderam ser processados corretamente.',
  },
  route: {
    title: 'Erro ao carregar a página',
    message: 'Ocorreu um erro ao exibir esta tela. Você pode voltar ou tentar novamente.',
  },
  unknown: {
    title: 'Ocorreu um erro',
    message: 'Ocorreu um erro ao carregar informações. Por favor, tente novamente.',
  },
};

const FRIENDLY_ERRORS: Record<string, FriendlyErrorEntry> = {
  VALIDATION_ERROR: {
    errorCode: 'VALIDATION_ERROR',
    title: 'Dados inválidos',
    message: 'Verifique os campos destacados e tente novamente.',
    action: 'review',
    category: 'validation',
  },
  NOT_FOUND: {
    errorCode: 'NOT_FOUND',
    title: 'Não encontrado',
    message: 'O item solicitado não foi encontrado. Ele pode ter sido removido ou movido.',
    action: 'review',
    category: 'unknown',
  },
  UNAUTHORIZED: {
    errorCode: 'UNAUTHORIZED',
    title: 'Sessão necessária',
    message: 'Sua sessão não está ativa. Recarregue a página para continuar.',
    action: 'review',
    category: 'system',
  },
  FORBIDDEN: {
    errorCode: 'FORBIDDEN',
    title: 'Acesso negado',
    message: 'Você não tem permissão para executar esta ação.',
    action: 'review',
    category: 'system',
  },
  CONFLICT: {
    errorCode: 'CONFLICT',
    title: 'Ação não permitida agora',
    message: 'Esta ação não pode ser concluída no estado atual. Atualize a tela e tente de novo.',
    action: 'review',
    category: 'validation',
  },
  // Demanda 10087 (CA4): quota do PROVEDOR de LLM (429/402) — diferente de
  // rate limit do próprio app: trocar de modelo resolve, esperar nem sempre.
  PROVIDER_QUOTA_EXCEEDED: {
    errorCode: 'PROVIDER_QUOTA_EXCEEDED',
    title: 'Limite do provedor atingido',
    message: 'Limite do provedor atingido — tente outro modelo ou aguarde.',
    action: 'retry',
    category: 'unavailable',
  },
  RATE_LIMIT_EXCEEDED: {
    errorCode: 'RATE_LIMIT_EXCEEDED',
    title: 'Muitas solicitações',
    message:
      'Você fez muitas solicitações em pouco tempo. Aguarde um pouco antes de tentar novamente.',
    action: 'wait',
    category: 'unavailable',
  },
  EXTERNAL_SERVICE_ERROR: {
    errorCode: 'EXTERNAL_SERVICE_ERROR',
    title: 'Serviço indisponível',
    message:
      'Um serviço necessário para esta ação está indisponível agora. Tente novamente em instantes.',
    action: 'retry',
    category: 'unavailable',
  },
  INTERNAL_ERROR: {
    errorCode: 'INTERNAL_ERROR',
    title: CATEGORY_TEXTS.system.title,
    message: CATEGORY_TEXTS.system.message,
    action: 'retry',
    category: 'system',
  },
  // Pseudo-códigos gerados no cliente (a requisição nem chegou ao backend)
  NETWORK_ERROR: {
    errorCode: 'NETWORK_ERROR',
    title: 'Sem conexão',
    message: 'Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.',
    action: 'retry',
    category: 'unavailable',
  },
  TIMEOUT: {
    errorCode: 'TIMEOUT',
    title: 'Tempo esgotado',
    message: 'O servidor demorou para responder. Tente novamente em instantes.',
    action: 'retry',
    category: 'unavailable',
  },
  UNKNOWN: {
    errorCode: 'UNKNOWN',
    title: CATEGORY_TEXTS.unknown.title,
    message: CATEGORY_TEXTS.unknown.message,
    action: 'retry',
    category: 'unknown',
  },
};

const STATUS_TO_ERROR_CODE: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION_ERROR',
  402: 'PROVIDER_QUOTA_EXCEEDED',
  429: 'RATE_LIMIT_EXCEEDED',
  502: 'EXTERNAL_SERVICE_ERROR',
  503: 'EXTERNAL_SERVICE_ERROR',
  504: 'TIMEOUT',
};

function resolveErrorCode(input: FriendlyErrorInput): string {
  if (input.errorCode && FRIENDLY_ERRORS[input.errorCode]) return input.errorCode;
  if (typeof input.status === 'number') {
    const mapped = STATUS_TO_ERROR_CODE[input.status];
    if (mapped) return mapped;
    if (input.status >= 500) return 'INTERNAL_ERROR';
  }
  return 'UNKNOWN';
}

function formatWaitMessage(retryAfter: number): string {
  if (retryAfter >= 120) {
    const minutes = Math.ceil(retryAfter / 60);
    return `Muitas solicitações em pouco tempo. Tente novamente em ${minutes} minutos.`;
  }
  return `Muitas solicitações em pouco tempo. Tente novamente em ${retryAfter} segundos.`;
}

/**
 * Traduz errorCode/status HTTP para uma entrada amigável em PT-BR.
 * Pura e síncrona; nunca expõe stack, serviço interno ou payload bruto.
 */
export function getFriendlyError(input: FriendlyErrorInput = {}): FriendlyErrorEntry {
  const code = resolveErrorCode(input);
  const entry = FRIENDLY_ERRORS[code];

  if (
    entry.errorCode === 'RATE_LIMIT_EXCEEDED' &&
    typeof input.retryAfter === 'number' &&
    input.retryAfter > 0
  ) {
    return { ...entry, message: formatWaitMessage(input.retryAfter) };
  }

  return entry;
}

/**
 * Conveniência para o padrão de toast: extrai errorCode/status/retryAfter de um
 * erro lançado pela camada de API (ApiError de client/src/lib/api.ts ou Error
 * genérico) e devolve a entrada amigável correspondente.
 */
export function getFriendlyErrorFromException(error: unknown): FriendlyErrorEntry {
  if (error && typeof error === 'object') {
    const maybe = error as {
      errorCode?: unknown;
      status?: unknown;
      retryAfter?: unknown;
      name?: unknown;
      message?: unknown;
    };
    const errorCode = typeof maybe.errorCode === 'string' ? maybe.errorCode : undefined;
    const status = typeof maybe.status === 'number' ? maybe.status : undefined;
    const retryAfter = typeof maybe.retryAfter === 'number' ? maybe.retryAfter : undefined;

    if (errorCode || status) {
      return getFriendlyError({ errorCode, status, retryAfter });
    }

    const message = typeof maybe.message === 'string' ? maybe.message : '';
    if (maybe.name === 'AbortError' || /timeout/i.test(message)) {
      return getFriendlyError({ errorCode: 'TIMEOUT' });
    }
    if (/failed to fetch|network|load failed/i.test(message)) {
      return getFriendlyError({ errorCode: 'NETWORK_ERROR' });
    }
  }
  return getFriendlyError({});
}
