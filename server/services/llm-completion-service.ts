import OpenAI from 'openai';
import { logger } from '../utils/logger';
import { errorHandlingManager } from './llm-error-handling-operations';
import { circuitBreaker } from './circuit-breaker';
import { llmClientManager, type AIProvider } from './llm-client-manager';
import {
  resolveProvider,
  normalizeModelForProvider,
  OPENROUTER_FALLBACK_MODEL,
  CAPABLE_MODEL,
  OPENROUTER_PRIMARY_MODEL,
} from './llm-model-router';
import { toOpenAIFallbackPayload, toOpenRouterFallbackPayload } from './llm-payload-builder';
import {
  isRetryableError,
  getErrorStatus,
  getRetryAfterDelayMs,
  parsePositiveInt,
  sleep,
} from './llm-retry-handler';
import {
  type RequestBudget,
  consumeAttempt,
  createFallbackBudget,
  disposeRequestBudget,
  getRemainingMs,
  isBudgetExpired,
  isGlobalBudgetExpired,
} from './request-budget';
import { refinementStageBudgetRemainingMs, refinementStageBudgetExpiredTotal } from '../metrics';

const DEFAULT_RETRY_ATTEMPTS = 3;

/**
 * Context for a completion request.
 */
export interface CompletionContext {
  operation: string;
  model: string;
  provider: AIProvider;
  retryAttempts?: number;
  /** Delay base (ms) entre retries. Padrão 350 ms. */
  retryDelayMs?: number;
  /**
   * Budget do estágio atual, ligado ao teto wall-clock global e ao contador
   * compartilhado de tentativas. Cada fallback recebe controller próprio.
   */
  budget?: RequestBudget;
  /**
   * Nível de fallback atual (para telemetria). Incrementado a cada nível da cascata.
   * 'primary' = primeira tentativa, 'explicit' = modelFallback configurado,
   * 'economic' = ROUTING_SAFE_MODEL, 'provider' = reroute de provider,
   * 'governance' = fallback de governança.
   */
  fallbackLevel?: 'primary' | 'explicit' | 'economic' | 'provider' | 'governance';
  /**
   * Spec 10126: timeout por chamada (ms). Se omitido, usa AI_CHAT_TIMEOUT_MS.
   */
  timeoutMs?: number;
}

/**
 * Result of a completion request.
 */
export interface CompletionResult {
  content: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model: string;
  provider: AIProvider;
}

/**
 * Resolves the number of retry attempts.
 */
function resolveRetryAttempts(value: number | undefined): number {
  const parsed =
    value ?? parsePositiveInt(process.env.OPENAI_RETRY_ATTEMPTS, DEFAULT_RETRY_ATTEMPTS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_RETRY_ATTEMPTS;
  }

  return Math.max(1, Math.min(4, Math.floor(parsed)));
}

/**
 * Checks if a provider error should be retried.
 */
/**
 * Demanda 10087 (CA1): erro de quota do provedor, distinto de erro genérico.
 * Carrega o provider e o status para o caller decidir mensagem/telemetria.
 */
export class QuotaExceededError extends Error {
  readonly provider: string;
  readonly status: number;
  /** Marcador para logs/telemetria (CA5). */
  readonly providerQuotaExceeded = true;

  constructor(provider: string, status: number, message?: string) {
    super(message ?? `Limite do provedor ${provider} atingido (HTTP ${status}).`);
    this.name = 'QuotaExceededError';
    this.provider = provider;
    this.status = status;
  }
}

/**
 * Demanda 10087: erro de quota do provedor — 429 (rate limit) ou 402
 * (créditos/pagamento esgotado). Ambos indicam "troque de provedor", não
 * "tente de novo o mesmo" — logo NÃO devem ser retry no mesmo provider nem
 * contar como falha de saúde; disparam a cadeia de fallback.
 */
function isProviderQuotaStatus(status: number | undefined): boolean {
  return status === 429 || status === 402;
}

function shouldRetryProviderError(provider: AIProvider, error: unknown): boolean {
  const status = getErrorStatus(error);

  // Quota (429/402) com outro provedor disponível: não retenta aqui — deixa o
  // fallback de provedor assumir.
  if (
    provider !== 'openai' &&
    isProviderQuotaStatus(status) &&
    llmClientManager.isProviderAvailable('openai')
  ) {
    return false;
  }

  if (status === 429) {
    return getRetryAfterDelayMs(error) !== null;
  }

  // 402 nunca é resolvido por retry no mesmo provedor (créditos não voltam
  // sozinhos) — sem outro provedor, propaga o erro em vez de insistir.
  if (status === 402) {
    return false;
  }

  return isRetryableError(error);
}

/**
 * Resolves the retry delay in milliseconds.
 */
function resolveRetryDelayMs(error: unknown, attempt: number, baseDelayMs = 350): number {
  const retryAfterDelayMs = getRetryAfterDelayMs(error);
  if (retryAfterDelayMs !== null) {
    return Math.max(retryAfterDelayMs, baseDelayMs);
  }

  return baseDelayMs * 2 ** (attempt - 1);
}

async function executeProviderFallback(
  client: OpenAI,
  requestPayload: Record<string, unknown>,
  context: CompletionContext,
  updates: Pick<CompletionContext, 'provider' | 'model'>,
): Promise<ReturnType<OpenAI['chat']['completions']['create']>> {
  const fallbackBudget = context.budget
    ? createFallbackBudget(context.budget, 'provider')
    : undefined;

  try {
    return await createChatCompletionWithRetry(client, requestPayload, {
      ...context,
      ...updates,
      budget: fallbackBudget,
      fallbackLevel: 'provider',
    });
  } finally {
    disposeRequestBudget(fallbackBudget);
  }
}

/**
 * Executes a chat completion with retry logic, circuit breaker, and provider fallback.
 *
 * @param client - OpenAI client to use
 * @param requestPayload - Request payload
 * @param context - Completion context
 * @returns Completion result
 */
export async function createChatCompletionWithRetry(
  client: OpenAI,
  requestPayload: Record<string, unknown>,
  context: CompletionContext,
): Promise<ReturnType<OpenAI['chat']['completions']['create']>> {
  const maxAttempts = resolveRetryAttempts(context.retryAttempts);
  let lastError: unknown;

  // Budget gate: se o deadline já expirou antes de entrar neste nível da cascata,
  // aborta imediatamente sem tentar de novo.
  // Spec 10012 F2/FR-008..010: instrumenta o budget WALL-CLOCK restante por operação
  // (o que de fato expira em "Request budget expired before document:prd") — não tokens.
  if (context.budget) {
    const fallbackLevel = context.fallbackLevel ?? 'primary';
    const remainingMs = getRemainingMs(context.budget);
    refinementStageBudgetRemainingMs.labels(context.operation, fallbackLevel).set(remainingMs);

    if (isBudgetExpired(context.budget)) {
      refinementStageBudgetExpiredTotal.labels(context.operation, fallbackLevel).inc();
      // FR-010: log com contexto completo (operação, nível, budget total e remanescente).
      logger.warn(`Request budget expired before ${context.operation}`, {
        context: {
          operation: context.operation,
          fallbackLevel,
          remainingMs,
          budgetMs: context.budget.budgetMs,
          stageBudgetMs: context.budget.stageBudgetMs,
        },
      });
      throw new Error(
        `Request budget expired before ${context.operation} (level=${fallbackLevel})`,
      );
    }
  }

  // Check circuit breaker before attempting
  const bypassProviderCircuit =
    context.provider === 'openrouter' && context.model === OPENROUTER_FALLBACK_MODEL;

  if (!bypassProviderCircuit && !circuitBreaker.canRequest(context.provider)) {
    logger.warn(`Circuit breaker is OPEN for ${context.provider}, checking for fallback`, {
      context: { operation: context.operation, model: context.model },
    });

    if (
      context.provider === 'openrouter' &&
      context.model !== OPENROUTER_FALLBACK_MODEL &&
      llmClientManager.isProviderAvailable('openrouter')
    ) {
      logger.info('Using OpenRouter fallback due to circuit breaker');
      const fallbackProvider = resolveProvider(OPENROUTER_FALLBACK_MODEL);
      const fallbackModel = normalizeModelForProvider(OPENROUTER_FALLBACK_MODEL, fallbackProvider);
      const fallbackPayload =
        fallbackProvider === 'openrouter'
          ? toOpenRouterFallbackPayload(requestPayload)
          : ({ ...requestPayload, model: fallbackModel } as Record<string, unknown>);

      return executeProviderFallback(
        llmClientManager.getClient(fallbackProvider),
        fallbackPayload,
        context,
        { provider: fallbackProvider, model: fallbackModel },
      );
    }

    if (llmClientManager.isProviderAvailable('openai')) {
      logger.info('Using OpenAI fallback due to circuit breaker');
      return executeProviderFallback(
        llmClientManager.getClient('openai'),
        toOpenAIFallbackPayload(requestPayload),
        context,
        { provider: 'openai', model: CAPABLE_MODEL },
      );
    }

    throw new Error(`No available provider for ${context.provider} (circuit breaker open)`);
  }

  // Retry loop
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Budget gate: cada tentativa consume uma unidade do teto total.
    // Se excedeu o teto de tentativas totais (REQUEST_MAX_TOTAL_ATTEMPTS)
    // ou a janela atual expirou, encerra este estágio.
    if (context.budget) {
      try {
        consumeAttempt(
          context.budget,
          `${context.operation} level=${context.fallbackLevel ?? 'primary'} attempt=${attempt}/${maxAttempts}`,
        );
      } catch (budgetError) {
        logger.warn('Cascade aborted by request budget', {
          context: {
            operation: context.operation,
            fallbackLevel: context.fallbackLevel,
            attempt,
            remainingMs: getRemainingMs(context.budget),
            attemptsUsed: context.budget.attemptsUsed.count,
          },
          error: errorHandlingManager.sanitizeAIError(budgetError),
        });
        throw budgetError;
      }
    }

    const timeoutMs =
      context.timeoutMs ?? parsePositiveInt(process.env.AI_CHAT_TIMEOUT_MS, 120_000);
    // Se o budget tem menos tempo que o timeout por chamada, usa o budget.
    // Isto garante que o deadline wall-clock global vence o timeout por chamada.
    const effectiveTimeoutMs = context.budget
      ? Math.min(timeoutMs, getRemainingMs(context.budget))
      : timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);

    try {
      const response = await client.chat.completions.create(
        requestPayload as unknown as Parameters<OpenAI['chat']['completions']['create']>[0],
        {
          signal: controller.signal,
        } as any,
      );
      circuitBreaker.recordSuccess(context.provider);
      return response;
    } catch (error) {
      lastError = error;
      const budgetExpired = Boolean(context.budget && isBudgetExpired(context.budget));
      // Demanda 10087 (CA2): quota (429/402) NÃO é falha de saúde do provedor —
      // contá-la abriria o circuito e derrubaria todos os providers por um limite
      // de cobrança. Fica só o log com o marcador de quota (CA5).
      const quotaExceeded = isProviderQuotaStatus(getErrorStatus(error));
      if (quotaExceeded) {
        logger.warn(`Provider quota exceeded (${context.provider})`, {
          context: {
            provider: context.provider,
            operation: context.operation,
            status: getErrorStatus(error),
            provider_quota_exceeded: true,
          },
        });
      } else if (!budgetExpired) {
        circuitBreaker.recordFailure(context.provider, error);
      }

      // Se o budget expirou durante a chamada, não retry — aborta a cascata.
      if (context.budget && isBudgetExpired(context.budget)) {
        logger.warn('Cascade aborted after attempt — budget expired', {
          context: {
            operation: context.operation,
            fallbackLevel: context.fallbackLevel,
            attempt,
          },
        });
        break;
      }

      if (attempt >= maxAttempts || !shouldRetryProviderError(context.provider, error)) {
        break;
      }

      const delayMs = resolveRetryDelayMs(error, attempt, context.retryDelayMs);
      errorHandlingManager.logSanitized(
        error,
        {
          operation: context.operation,
          attempt,
          nextAttempt: attempt + 1,
          delayMs,
          provider: context.provider,
          model: context.model,
        },
        'warn',
      );
      await sleep(delayMs);
    } finally {
      clearTimeout(timer);
    }
  }

  // O fim da janela atual permite fallback; somente o teto global bloqueia a cascata.
  if (context.budget && isGlobalBudgetExpired(context.budget)) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`Request budget expired before fallback level for ${context.operation}`);
  }

  // Provider fallback for rate limit
  if (context.provider === 'openrouter' && context.model !== OPENROUTER_FALLBACK_MODEL) {
    const fallbackProvider = resolveProvider(OPENROUTER_FALLBACK_MODEL);
    const fallbackModel = normalizeModelForProvider(OPENROUTER_FALLBACK_MODEL, fallbackProvider);
    if (llmClientManager.isProviderAvailable(fallbackProvider)) {
      logger.warn(
        `OpenRouter primary model failed. Attempting fallback via ${fallbackProvider}...`,
      );
      const fallbackPayload = { ...requestPayload, model: fallbackModel };
      return executeProviderFallback(
        llmClientManager.getClient(fallbackProvider),
        fallbackPayload,
        context,
        { provider: fallbackProvider, model: fallbackModel },
      );
    }
  }

  if (
    context.provider !== 'openrouter' &&
    llmClientManager.isProviderAvailable('openrouter') &&
    circuitBreaker.canRequest('openrouter')
  ) {
    const openrouterFallbackModel = OPENROUTER_PRIMARY_MODEL;
    logger.warn(
      `Primary provider ${context.provider} failed. Attempting fallback to OpenRouter with ${openrouterFallbackModel}...`,
    );
    const fallbackPayload = {
      ...toOpenRouterFallbackPayload(requestPayload),
      model: openrouterFallbackModel,
    };
    return executeProviderFallback(
      llmClientManager.getClient('openrouter'),
      fallbackPayload,
      context,
      { provider: 'openrouter', model: openrouterFallbackModel },
    );
  }

  if (
    context.provider !== 'openai' &&
    context.provider !== 'openrouter' &&
    llmClientManager.isProviderAvailable('openai') &&
    circuitBreaker.canRequest('openai')
  ) {
    logger.warn(`Primary provider ${context.provider} failed. Attempting fallback to OpenAI...`);
    const fallbackModel = CAPABLE_MODEL;
    const fallbackPayload = toOpenAIFallbackPayload(requestPayload);

    return executeProviderFallback(llmClientManager.getClient('openai'), fallbackPayload, context, {
      provider: 'openai',
      model: fallbackModel,
    });
  }

  // Demanda 10087 (CA1): se a cascata esgotou por quota, propaga o erro TIPADO
  // para o caller distinguir "limite do provedor" de falha genérica.
  const finalStatus = getErrorStatus(lastError);
  if (isProviderQuotaStatus(finalStatus)) {
    throw new QuotaExceededError(context.provider, finalStatus as number);
  }
  throw lastError || new Error('Completion failed after all retries');
}

/**
 * Creates a chat completion request without retry logic.
 *
 * @param client - OpenAI client
 * @param requestPayload - Request payload
 * @returns Response from OpenAI API
 *
 * @deprecated Dead-code-report-AiChatFlow1-2026-07-28 (demanda #10269):
 * função sem caller confirmado; preservada para decisão futura. TODO: remover
 * ou reintegrar ao fluxo de completion.
 */
export async function createChatCompletionRequest(
  client: OpenAI,
  requestPayload: Record<string, unknown>,
): Promise<any> {
  return client.chat.completions.create(requestPayload as any);
}
