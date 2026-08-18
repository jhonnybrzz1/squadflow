import { resolvePath } from '@shared/utils/paths';
/**
 * Serviço de logging estruturado para AIChatFlow
 * Implementa logging com níveis, contexto e suporte para diferentes transportes
 */

import winston from 'winston';
import path from 'path';
import fs from 'fs';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

// Tipos de log
type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'verbose';

export type StructuredLogger = Pick<LoggerService, 'info' | 'error' | 'warn'> & { traceId: string };

interface LogContext {
  [key: string]: unknown;
}

interface LogOptions {
  level?: LogLevel;
  context?: LogContext;
  // Aceita o valor capturado em `catch (error)` (tipado como `unknown`);
  // normalizado para Error em formatLogMessage.
  error?: unknown;
  stackTrace?: boolean;
  // Permite campos estruturados ad-hoc (ex.: rawResponse, ids) sem alargar
  // para `any`; preservados no output via `...rest`.
  [key: string]: unknown;
}

class LoggerService {
  private logger: winston.Logger;
  private serviceName: string;

  constructor(serviceName: string = 'AIChatFlow') {
    this.serviceName = serviceName;
    this.logger = this.createLogger();
  }

  private createLogger(): winston.Logger {
    // Criar diretório de logs se não existir
    const logDir = resolvePath('logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Formato de log
    const logFormat = winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.json(),
    );

    // Transportes
    const transports = [
      // Console transport
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.printf((info) => {
            const { timestamp, level, message, service, context, stack, ...rest } = info;
            let logMessage = `${timestamp} [${level}] ${service || this.serviceName}: ${message}`;

            if (context && Object.keys(context).length > 0) {
              logMessage += ` ${JSON.stringify(context)}`;
            }

            if (stack) {
              logMessage += `\n${stack}`;
            }

            if (Object.keys(rest).length > 0) {
              logMessage += ` ${JSON.stringify(rest)}`;
            }

            return logMessage;
          }),
        ),
        level: 'debug',
      }),

      // File transport para erros
      new winston.transports.File({
        filename: path.join(logDir, 'error.log'),
        level: 'error',
        format: logFormat,
        maxsize: 10485760, // 10MB
        maxFiles: 5,
      }),

      // File transport para todos os logs
      new winston.transports.File({
        filename: path.join(logDir, 'combined.log'),
        format: logFormat,
        maxsize: 10485760, // 10MB
        maxFiles: 5,
      }),
    ];

    return winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      levels: winston.config.npm.levels,
      format: logFormat,
      transports,
      exitOnError: false,
      silent: process.env.NODE_ENV === 'test',
    });
  }

  private formatLogMessage(
    message: string,
    options: unknown = {},
    level: LogLevel = 'info',
  ): Record<string, unknown> {
    // Aceita LogOptions, um Error cru (logger.warn('msg', error)) ou qualquer
    // valor capturado em catch; normaliza para LogOptions.
    const opts: LogOptions =
      options instanceof Error
        ? { error: options }
        : options && typeof options === 'object'
          ? (options as LogOptions)
          : {};

    const { context, error, stackTrace = true, level: _level, ...rest } = opts;

    const logData: Record<string, unknown> = {
      service: this.serviceName,
      message,
      level,
      ...rest,
    };

    if (context) {
      logData.context = context;
    }

    if (error) {
      const errObj =
        error instanceof Error
          ? error
          : new Error(typeof error === 'string' ? error : JSON.stringify(error));
      // S3: do not leak internal error class names in logs for unexpected errors.
      // AppError subclasses are operational and safe; other Error names may
      // expose library internals or host details.
      const isOperationalError =
        typeof (errObj as { isOperational?: boolean }).isOperational === 'boolean' &&
        typeof (errObj as { errorCode?: string }).errorCode === 'string';
      const errorCode = (errObj as { errorCode?: string }).errorCode;
      const safeName = isOperationalError ? errObj.name : 'InternalServerError';
      logData.error = {
        name: safeName,
        message: errObj.message,
        ...(errorCode ? { errorCode } : {}),
        ...(stackTrace && { stack: errObj.stack }),
      };
    }

    return logData;
  }

  /**
   * Log de erro
   */
  error(message: string, options: unknown = {}): void {
    this.logger.error(this.formatLogMessage(message, options, 'error'));
  }

  /**
   * Log de aviso
   */
  warn(message: string, options: unknown = {}): void {
    this.logger.warn(this.formatLogMessage(message, options, 'warn'));
  }

  /**
   * Log de informação
   */
  info(message: string, options: unknown = {}): void {
    this.logger.info(this.formatLogMessage(message, options, 'info'));
  }

  /**
   * Log de debug
   */
  debug(message: string, options: unknown = {}): void {
    this.logger.debug(this.formatLogMessage(message, options, 'debug'));
  }

  /**
   * Log verbose
   */
  verbose(message: string, options: unknown = {}): void {
    this.logger.verbose(this.formatLogMessage(message, options, 'verbose'));
  }

  /**
   * Log de erro com contexto adicional
   */
  errorWithContext(message: string, context: LogContext, error?: Error): void {
    this.error(message, { context, error });
  }

  /**
   * Log de API request
   */
  logRequest(
    method: string,
    path: string,
    status: number,
    duration: number,
    context?: LogContext,
  ): void {
    this.info(`HTTP ${method} ${path} ${status} ${duration}ms`, {
      context: {
        method,
        path,
        status,
        duration,
        ...context,
      },
    });
  }

  /**
   * Log de evento de negócio
   */
  logBusinessEvent(
    eventName: string,
    entityType: string,
    entityId: string,
    context?: LogContext,
  ): void {
    this.info(`Business Event: ${eventName}`, {
      context: {
        eventName,
        entityType,
        entityId,
        ...context,
      },
    });
  }

  /**
   * Log de métrica
   */
  logMetric(metricName: string, value: number, context?: LogContext): void {
    this.info(`Metric: ${metricName}`, {
      context: {
        metricName,
        value,
        ...context,
      },
    });
  }

  /**
   * Middleware de logging para Express
   */
  expressMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const start = Date.now();
      const { method, path, query, params, body } = req;

      // Log da requisição
      this.debug('Request started', {
        context: {
          method,
          path,
          query,
          params,
          body: this.sanitizeRequestBody(body),
        },
      });

      // Interceptar a resposta
      const originalSend = res.send;
      res.send = (body: unknown) => {
        const duration = Date.now() - start;
        const status = res.statusCode;

        this.logRequest(method, path, status, duration, {
          responseSize: typeof body === 'string' ? body.length : undefined,
        });

        return originalSend.call(res, body);
      };

      // Tratar erros
      res.on('finish', () => {
        const duration = Date.now() - start;
        const status = res.statusCode;

        if (status >= 400) {
          this.warn(`Request completed with status ${status}`, {
            context: {
              method,
              path,
              duration,
              status,
            },
          });
        }
      });

      next();
    };
  }

  /**
   * Sanitiza o corpo da requisição para logging
   */
  private sanitizeRequestBody(body: unknown): unknown {
    if (!body || typeof body !== 'object') {
      return body;
    }

    // Criar uma cópia do corpo
    const sanitized: Record<string, unknown> = { ...(body as Record<string, unknown>) };

    // Remover campos sensíveis
    const sensitiveFields = [
      'password',
      'token',
      'apiKey',
      'secret',
      'authorization',
      'prompt',
      'messages',
      'content',
    ];

    sensitiveFields.forEach((field) => {
      if (sanitized[field]) {
        sanitized[field] = '[REDACTED]';
      }
    });

    return sanitized;
  }

  /**
   * Obtém estatísticas do logger
   */
  getStats(): { level: string; serviceName: string } {
    return {
      level: this.logger.level,
      serviceName: this.serviceName,
    };
  }
}

// Instância singleton do logger
export const logger = new LoggerService();

// Funções de conveniência para importação direta
export const logError = (message: string, options?: LogOptions) => logger.error(message, options);
export const logWarn = (message: string, options?: LogOptions) => logger.warn(message, options);
export const logInfo = (message: string, options?: LogOptions) => logger.info(message, options);

/**
 * B-1: cria um logger estruturado vinculado a uma requisição Express.
 *
 * - Em desenvolvimento (NODE_ENV !== 'production') exige `req` e throwa se
 *   omitido, forçando o time a passar o contexto de tracing.
 * - Em produção aceita `req` ausente e gera um traceId aleatório, tolerante
 *   a chamadas em background sem request HTTP.
 *
 * O schema de cada log inclui: level, timestamp, message, service, traceId,
 * context e stack (quando houver error).
 */
export function createLogger(req?: Request): StructuredLogger {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!req) {
    if (!isProduction) {
      throw new Error('B-1: createLogger(req) exige um objeto Request em desenvolvimento.');
    }
  }

  const traceId = req?.traceId ?? randomUUID();
  const serviceName = 'AIChatFlow';

  const baseLog = (level: LogLevel, message: string, options?: LogOptions): void => {
    const timestamp = new Date().toISOString();
    const logData: Record<string, unknown> = {
      level,
      timestamp,
      message,
      service: serviceName,
      traceId,
      context: options?.context ?? {},
    };

    if (options?.error) {
      const err =
        options.error instanceof Error
          ? options.error
          : new Error(
              typeof options.error === 'string' ? options.error : JSON.stringify(options.error),
            );
      logData.stack = err.stack;
      logData.error = {
        name: err.name,
        message: err.message,
      };
    }

    switch (level) {
      case 'error':
        logger.error(message, logData);
        break;
      case 'warn':
        logger.warn(message, logData);
        break;
      case 'info':
        logger.info(message, logData);
        break;
      case 'debug':
        logger.debug(message, logData);
        break;
      case 'verbose':
        logger.verbose(message, logData);
        break;
      default:
        logger.info(message, logData);
    }
  };

  return {
    traceId,
    info: (message: string, options?: LogOptions) => baseLog('info', message, options),
    warn: (message: string, options?: LogOptions) => baseLog('warn', message, options),
    error: (message: string, options?: LogOptions) => baseLog('error', message, options),
  };
}

/**
 * B-1: middleware Express que injeta `req.traceId` quando ausente.
 * O header `X-Request-Id` é respeitado se presente, senão gera UUID.
 */
export function traceIdMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (!req.traceId) {
    const incoming = req.get('X-Request-Id')?.trim();
    req.traceId = incoming && incoming.length > 0 ? incoming : randomUUID();
  }
  next();
}

export const logDebug = (message: string, options?: LogOptions) => logger.debug(message, options);
