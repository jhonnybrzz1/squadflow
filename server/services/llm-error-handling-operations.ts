/**
 * LLM Error Handling Operations
 *
 * Gerencia operações de error handling para LLM calls:
 * - Sanitização de erros
 * - Extração de mensagens de erro
 * - Formatação de erros para logging
 */

import { logger } from '../utils/logger';

export interface ErrorSanitizationResult {
  message: string;
  status?: number;
  type?: string;
  details?: Record<string, unknown>;
}

/**
 * Avaliação de LLM (2026-07-26, B-1): a sanitização anterior só redigia por
 * NOME de campo (`apiKey`, `token`...) — uma chave/token embutida dentro do
 * texto de `message` (ex.: provedor devolve "Invalid key: sk-abc123...")
 * passava intacta, já que `message` nunca era escaneado por conteúdo.
 * Estes padrões cobrem os formatos mais comuns de segredo em texto livre.
 *
 * B-1 (2026-07-28): adicionados padrões para Bearer tokens, paths absolutos
 * e variáveis de ambiente, tornando o redaction recursivo e aplicado antes
 * de qualquer log de erro.
 */
const SECRET_CONTENT_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI/OpenRouter-style keys
  /\bBearer\s+[A-Za-z0-9._-]{6,}\b/gi, // Authorization: Bearer <token>
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{16,}\b/g, // JWT-shaped
  /(?:^|[^A-Za-z0-9])(\/[^\s\n]*(?:home|Users|private|secret|\.env)[^\s\n]*)/gi, // paths absolutos com termos sensíveis
  /(?:^|[^A-Za-z0-9])(\/Users\/[^\s\n]+)/g, // macOS user paths
  /(?:^|[^A-Za-z0-9])(\/home\/[^\s\n]+)/g, // Linux user paths
  /(?:^|[^A-Za-z0-9])(C:\\\\[^\s\n]+)/gi, // Windows paths (escape para string)
  /\bprocess\.env\.[A-Za-z_][A-Za-z0-9_]*\b/g, // process.env.<NAME>
  /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, // ${VAR}
];

function redactSecretPatterns(text: string): string {
  return SECRET_CONTENT_PATTERNS.reduce((acc, pattern) => {
    return acc.replace(pattern, (match) => {
      const trimmed = match.trimStart();
      const leading = match.slice(0, match.length - trimmed.length);
      if (match.toLowerCase().startsWith('bearer ')) return `${leading}Bearer [REDACTED]`;
      if (match.includes('/') || match.includes('\\')) return `${leading}[REDACTED_PATH]`;
      if (match.includes('process.env') || match.includes('${')) return `${leading}[REDACTED_ENV]`;
      return `${leading}[REDACTED]`;
    });
  }, text);
}

export class ErrorHandlingManager {
  /**
   * Sanitiza erro para logging seguro (remove dados sensíveis)
   */
  sanitizeAIError(error: unknown): ErrorSanitizationResult {
    if (error instanceof Error) {
      const cause = error.cause ? this.sanitizeAIError(error.cause) : undefined;
      const details = cause ? { cause } : undefined;
      return {
        message: redactSecretPatterns(error.message),
        type: error.name,
        details,
      };
    }

    if (typeof error === 'string') {
      return {
        message: redactSecretPatterns(error),
        type: 'StringError',
      };
    }

    if (error && typeof error === 'object') {
      const errorObj = error as Record<string, unknown>;
      const cause = errorObj.cause ? this.sanitizeAIError(errorObj.cause) : undefined;
      const details = this.sanitizeErrorDetails(errorObj);
      if (cause) details.cause = cause;

      return {
        message: redactSecretPatterns(
          String(errorObj.message || errorObj.error || 'Unknown error'),
        ),
        type: String(errorObj.type || errorObj.name || 'ObjectError'),
        status: typeof errorObj.status === 'number' ? errorObj.status : undefined,
        details,
      };
    }

    return {
      message: 'Unknown error',
      type: 'UnknownError',
    };
  }

  /**
   * Sanitiza detalhes do erro removendo dados sensíveis
   */
  private sanitizeErrorDetails(
    errorObj: Record<string, unknown>,
    depth = 0,
    maxDepth = 2,
  ): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    const sensitiveKeys = [
      'apiKey',
      'api_key',
      'token',
      'password',
      'secret',
      'authorization',
      'key',
    ];

    for (const [key, value] of Object.entries(errorObj)) {
      const keyLower = key.toLowerCase();
      if (key === 'cause') continue; // tratado recursivamente em sanitizeAIError
      if (sensitiveKeys.some((sensitive) => keyLower.includes(sensitive))) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'string') {
        const redacted = redactSecretPatterns(value);
        sanitized[key] = redacted.length > 200 ? redacted.slice(0, 200) + '...' : redacted;
      } else if (typeof value === 'object' && value !== null) {
        if (value instanceof Error) {
          sanitized[key] = this.sanitizeAIError(value);
        } else if (Array.isArray(value)) {
          sanitized[key] = value.map((v) =>
            typeof v === 'string'
              ? redactSecretPatterns(v)
              : v instanceof Error
                ? this.sanitizeAIError(v)
                : v,
          );
        } else if (depth < maxDepth) {
          // Expande um nível para sanitizar headers, request, response etc.
          const nested = value as Record<string, unknown>;
          const nestedSanitized: Record<string, unknown> = {};
          for (const [nestedKey, nestedValue] of Object.entries(nested)) {
            if (sensitiveKeys.some((sensitive) => nestedKey.toLowerCase().includes(sensitive))) {
              nestedSanitized[nestedKey] = '[REDACTED]';
            } else if (typeof nestedValue === 'string') {
              nestedSanitized[nestedKey] = redactSecretPatterns(nestedValue);
            } else {
              nestedSanitized[nestedKey] = nestedValue;
            }
          }
          sanitized[key] = nestedSanitized;
        } else {
          sanitized[key] = '[Object]';
        }
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Wrapper centralizado: único ponto de escrita de logs de erro.
   * Aplica sanitização antes de delegar ao logger.
   */
  logSanitized(
    error: unknown,
    context?: string | Record<string, unknown>,
    level: 'error' | 'warn' = 'error',
  ): void {
    const sanitized = this.sanitizeAIError(error);
    const contextObj = typeof context === 'string' ? { context } : (context ?? {});
    const payload = {
      ...contextObj,
      ...sanitized,
    };

    if (level === 'warn') {
      logger.warn('Sanitized LLM error', payload);
    } else {
      logger.error('Sanitized LLM error', payload);
    }
  }

  /**
   * Extrai mensagem de erro de forma segura
   */
  getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === 'string') {
      return error;
    }

    if (error && typeof error === 'object') {
      const errorObj = error as Record<string, unknown>;
      return String(errorObj.message || errorObj.error || 'Unknown error');
    }

    return 'Unknown error';
  }

  /**
   * Extrai status code de erro quando disponível
   */
  getErrorStatus(error: unknown): number | undefined {
    if (error && typeof error === 'object') {
      const errorObj = error as Record<string, unknown>;
      if (typeof errorObj.status === 'number') {
        return errorObj.status;
      }
      if (typeof errorObj.statusCode === 'number') {
        return errorObj.statusCode;
      }
    }
    return undefined;
  }

  /**
   * Extrai header específico de erro
   */
  getHeaderValue(error: unknown, headerName: string): string | undefined {
    if (error && typeof error === 'object') {
      const errorObj = error as Record<string, unknown>;
      const headers = errorObj.headers as Record<string, string> | undefined;
      if (headers && headers[headerName]) {
        return headers[headerName];
      }
    }
    return undefined;
  }
}

export const errorHandlingManager = new ErrorHandlingManager();
