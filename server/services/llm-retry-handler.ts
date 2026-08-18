import { logger } from '../utils/logger';
import {
  type RequestBudget,
  consumeAttempt,
  getRemainingMs,
  isBudgetExpired,
} from './request-budget';

/**
 * Configurações de retry para chamadas de LLM.
 */
export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

/**
 * Configuração padrão de retry.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 350,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

/**
 * Resultado de uma tentativa de retry.
 */
export interface RetryAttemptResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  attempt: number;
  totalAttempts: number;
}

/**
 * Executa uma função com lógica de retry exponencial.
 *
 * @param fn - Função a executar com retry
 * @param config - Configuração de retry
 * @param budget - Budget global do request (opcional). Se fornecido, cada
 *   tentativa consume uma unidade e a cascata aborta quando expira o deadline
 *   ou excede o teto de tentativas totais. Isto impede o pior caso
 *   retry × fallback × timeout sem teto.
 * @returns Resultado da execução
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  budget?: RequestBudget,
): Promise<T> {
  let lastError: Error | undefined;
  const { maxAttempts, initialDelayMs, maxDelayMs, backoffMultiplier } = config;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Budget gate: aborta a cascata se deadline expirou ou teto de tentativas
    // totais (não apenas por-nível) foi excedido.
    try {
      consumeAttempt(budget, `retry attempt ${attempt}/${maxAttempts}`);
    } catch (budgetError) {
      logger.warn('Retry aborted by request budget', {
        error: budgetError instanceof Error ? budgetError : undefined,
        attempt,
        maxAttempts,
      });
      throw budgetError;
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Se o budget expirou durante a chamada, não retry — aborta a cascata.
      if (budget && isBudgetExpired(budget)) {
        logger.warn('Retry aborted after attempt — budget expired', {
          attempt,
          remainingMs: getRemainingMs(budget),
        });
        throw lastError;
      }

      if (attempt === maxAttempts) {
        logger.error(`Retry failed after ${maxAttempts} attempts`, {
          error: lastError,
        });
        throw lastError;
      }

      const delayMs = Math.min(
        initialDelayMs * Math.pow(backoffMultiplier, attempt - 1),
        maxDelayMs,
      );

      logger.warn(`Retry attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMs}ms`, {
        error: lastError,
      });

      await sleep(delayMs);
    }
  }

  throw lastError || new Error('Retry failed');
}

/**
 * Verifica se um erro é retryável baseado no tipo e status HTTP.
 *
 * @param error - O erro a verificar
 * @returns true se o erro deve ser retryado
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const status = getErrorStatus(error);

    // Retry em erros de rede e timeouts
    if (
      message.includes('timeout') ||
      message.includes('etimedout') ||
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('econnreset') ||
      message.includes('abort') ||
      error.name === 'AbortError'
    ) {
      return true;
    }

    // Retry em rate limit (429) e erros de servidor (5xx)
    if (status === 429 || (status && status >= 500 && status < 600)) {
      return true;
    }
  }

  return false;
}

/**
 * Extrai o status HTTP de um erro, se disponível.
 *
 * @param error - O erro a analisar
 * @returns Status HTTP ou undefined
 */
export function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const err = error as Record<string, unknown>;
  const status = err.status as number | undefined;

  if (typeof status === 'number') {
    return status;
  }

  // Tenta extrair de propriedades aninhadas
  const response = err.response as Record<string, unknown> | undefined;
  if (response && typeof response === 'object') {
    const responseStatus = response.status as number | undefined;
    if (typeof responseStatus === 'number') {
      return responseStatus;
    }
  }

  return undefined;
}

/**
 * Extrai o valor de um header específico de um erro.
 *
 * @param error - O erro a analisar
 * @param headerName - Nome do header (case-insensitive)
 * @returns Valor do header ou undefined
 */
export function getHeaderValue(error: unknown, headerName: string): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const err = error as Record<string, unknown>;
  const headers = err.headers as Record<string, string> | undefined;

  if (!headers || typeof headers !== 'object') {
    return undefined;
  }

  // Case-insensitive header lookup
  const lowerHeaderName = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerHeaderName) {
      return String(value);
    }
  }

  return undefined;
}

/**
 * Extrai o delay de retry-after do header, se disponível.
 *
 * @param error - O erro a analisar
 * @returns Delay em ms ou null
 */
export function getRetryAfterDelayMs(error: unknown): number | null {
  const retryAfter = getHeaderValue(error, 'retry-after');
  if (!retryAfter) {
    return null;
  }

  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const retryAt = Date.parse(retryAfter);
  if (Number.isFinite(retryAt)) {
    return Math.max(0, retryAt - Date.now());
  }

  return null;
}

/**
 * Sanitiza uma mensagem de erro removendo informações sensíveis.
 *
 * @param text - Texto a sanitizar
 * @returns Texto sanitizado
 */
export function redactSensitiveText(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>');
}

/**
 * Extrai a mensagem de erro de forma segura.
 *
 * @param error - O erro a analisar
 * @returns Mensagem de erro sanitizada
 */
export function getErrorMessage(error: unknown): string {
  const redact = (message: string): string => redactSensitiveText(message).slice(0, 500);

  if (error instanceof Error && error.message) {
    return redact(error.message);
  }

  if (typeof error === 'string') {
    return redact(error);
  }

  return 'AI request failed';
}

/**
 * Função utilitária para sleep/delay.
 *
 * @param ms - Milissegundos para dormir
 * @returns Promise que resolve após o delay
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse um valor inteiro positivo com fallback.
 *
 * @param value - Valor a parsear
 * @param fallback - Valor de fallback
 * @returns Inteiro parseado ou fallback
 */
export function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Extrai o request ID de um erro, se disponível.
 *
 * @param error - O erro a analisar
 * @returns Request ID ou undefined
 */
export function getRequestId(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const err = error as Record<string, unknown>;

  // Tenta extrair diretamente do erro
  const directRequestId = err.request_id as string | undefined;
  if (directRequestId) {
    return directRequestId;
  }

  // Tenta extrair de headers
  const headers = err.headers as { get?: (key: string) => unknown } | undefined;
  const headerRequestId = headers?.get?.('x-request-id');
  return typeof headerRequestId === 'string' ? headerRequestId : undefined;
}
