/**
 * Middleware centralizado de tratamento de erros
 * Fase 1 - Item 1.1: Estabilização
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { ZodError } from 'zod';
import { ModelGovernanceError } from '../services/model-governance';

// ============================================
// Custom Error Classes
// ============================================

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly isOperational: boolean;
  public readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    statusCode: number = 500,
    errorCode: string = 'INTERNAL_ERROR',
    context?: Record<string, unknown>,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.isOperational = true;
    this.context = context;

    Object.setPrototypeOf(this, AppError.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  public readonly issues: Array<{ path: string; message: string }>;

  constructor(
    message: string = 'Validation failed',
    issues: Array<{ path: string; message: string }> = [],
  ) {
    super(message, 400, 'VALIDATION_ERROR');
    this.issues = issues;
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string = 'Resource', id?: string | number) {
    const message = id ? `${resource} with id '${id}' not found` : `${resource} not found`;
    super(message, 404, 'NOT_FOUND', { resource, id });
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Authentication required') {
    super(message, 401, 'UNAUTHORIZED');
    Object.setPrototypeOf(this, UnauthorizedError.prototype);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Access denied') {
    super(message, 403, 'FORBIDDEN');
    Object.setPrototypeOf(this, ForbiddenError.prototype);
  }
}

export class ConflictError extends AppError {
  public readonly currentState?: string;
  public readonly allowedActions?: string[];

  constructor(message: string, currentState?: string, allowedActions?: string[]) {
    super(message, 409, 'CONFLICT', { currentState, allowedActions });
    this.currentState = currentState;
    this.allowedActions = allowedActions;
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}

export class ExternalServiceError extends AppError {
  public readonly serviceName: string;
  public readonly originalError?: Error;

  constructor(
    serviceName: string,
    message: string = 'External service error',
    originalError?: Error,
  ) {
    super(message, 502, 'EXTERNAL_SERVICE_ERROR', { serviceName });
    this.serviceName = serviceName;
    this.originalError = originalError;
    Object.setPrototypeOf(this, ExternalServiceError.prototype);
  }
}

export class RateLimitError extends AppError {
  public readonly retryAfter?: number;

  constructor(message: string = 'Rate limit exceeded', retryAfter?: number) {
    super(message, 429, 'RATE_LIMIT_EXCEEDED', { retryAfter });
    this.retryAfter = retryAfter;
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

// ============================================
// Sanitization Helpers
// ============================================

const SENSITIVE_CONTEXT_KEYS = new Set([
  'password',
  'token',
  'apiKey',
  'secret',
  'authorization',
  'prompt',
  'messages',
  'input',
  'content',
  'stack',
  'error',
  'originalError',
  'detections',
]);

const MAX_CONTEXT_STRING = 500;
const MAX_CONTEXT_DEPTH = 2;

function sanitizeDetections(detections: unknown): { types: string[]; count: number } {
  const safeTypes: string[] = [];
  if (Array.isArray(detections)) {
    for (const d of detections) {
      if (typeof d === 'string' && d.length <= 64 && /^[a-z0-9_\-:./]+$/i.test(d)) {
        safeTypes.push(d);
      } else if (typeof d === 'string') {
        safeTypes.push('masked');
      }
    }
  }
  const unique = Array.from(new Set(safeTypes)).slice(0, 20);
  return { types: unique, count: unique.length };
}

function sanitizeErrorContext(context: unknown, depth = 0): unknown {
  if (context === null || context === undefined) return undefined;
  if (typeof context !== 'object') return String(context).slice(0, MAX_CONTEXT_STRING);
  if (depth > MAX_CONTEXT_DEPTH) return '[nested]';

  if (Array.isArray(context)) {
    return context.map((item) => {
      if (item === null || item === undefined) return item;
      if (typeof item === 'string') return item.slice(0, MAX_CONTEXT_STRING);
      if (typeof item === 'number' || typeof item === 'boolean') return item;
      return '[item]';
    });
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context as Record<string, unknown>)) {
    if (SENSITIVE_CONTEXT_KEYS.has(key.toLowerCase())) {
      result[key] = '[REDACTED]';
      continue;
    }
    if (value instanceof Error) {
      result[key] = { message: value.message.slice(0, MAX_CONTEXT_STRING), name: '[Error]' };
      continue;
    }
    if (typeof value === 'string') {
      result[key] =
        value.length > MAX_CONTEXT_STRING ? value.slice(0, MAX_CONTEXT_STRING) + '...' : value;
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeErrorContext(value, depth + 1);
      continue;
    }
    result[key] = value;
  }
  return result;
}

// ============================================
// Error Response Interface
// ============================================

interface ErrorResponse {
  error: string;
  errorCode: string;
  message: string;
  statusCode: number;
  timestamp: string;
  path?: string;
  issues?: Array<{ path: string; message: string }>;
  context?: Record<string, unknown>;
  stack?: string;
  requestId?: string;
}

// ============================================
// Error Formatting Functions
// ============================================

function formatZodError(error: ZodError): ValidationError {
  const issues = error.errors.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
  return new ValidationError('Invalid request data', issues);
}

function formatErrorResponse(
  error: AppError | Error,
  req: Request,
  includeStack: boolean,
): ErrorResponse {
  const isAppError = error instanceof AppError;
  const statusCode = isAppError ? error.statusCode : 500;
  const errorCode = isAppError ? error.errorCode : 'INTERNAL_ERROR';

  // H-8: for unexpected (non-operational) 500 errors, replace the raw error
  // message with a generic one in production. The raw message may contain
  // internal paths, DB connection strings, stack fragments, or other sensitive
  // info. The full error is already logged server-side. In development, the
  // real message is preserved for debugging. Operational errors (AppError
  // subclasses: ValidationError, NotFoundError, etc.) have user-safe messages.
  const isDevelopment = process.env.NODE_ENV === 'development';
  const safeMessage = !isAppError && !isDevelopment ? 'Internal Server Error' : error.message;

  const response: ErrorResponse = {
    error: isAppError ? error.name : 'InternalServerError',
    errorCode,
    message: safeMessage,
    statusCode,
    timestamp: new Date().toISOString(),
    path: req.path,
  };

  if (error instanceof ValidationError && error.issues.length > 0) {
    response.issues = error.issues;
  }

  if (error instanceof ConflictError) {
    if (error.currentState) {
      response.context = {
        ...response.context,
        currentState: error.currentState,
        allowedActions: error.allowedActions,
      };
    }
  }

  if (isAppError && error.context) {
    const sanitizedContext = sanitizeErrorContext(error.context);
    if (
      sanitizedContext &&
      typeof sanitizedContext === 'object' &&
      !Array.isArray(sanitizedContext) &&
      Object.keys(sanitizedContext).length > 0
    ) {
      response.context = { ...response.context, ...sanitizedContext };
    } else if (sanitizedContext) {
      // Operational context is a primitive/array — wrap it under a generic key
      response.context = { ...response.context, context: sanitizedContext };
    }
  }

  if (includeStack && error.stack) {
    response.stack = error.stack;
  }

  const requestId = req.headers['x-request-id'];
  if (typeof requestId === 'string' && requestId.length > 0) {
    response.requestId = requestId;
  }

  return response;
}

// ============================================
// Error Handler Middleware
// ============================================

/**
 * Formato mínimo de `GuardrailBlockError` (`server/services/openai-ai.ts`).
 * O discriminante `isGuardrailBlock` já existe na classe justamente para
 * permitir esta checagem sem acoplar o middleware ao serviço de LLM.
 */
interface GuardrailBlockErrorShape extends Error {
  isGuardrailBlock: true;
  reason: string;
  detections: string[];
}

function isGuardrailBlockError(err: Error): err is GuardrailBlockErrorShape {
  return (
    (err as Partial<GuardrailBlockErrorShape>).isGuardrailBlock === true &&
    typeof (err as Partial<GuardrailBlockErrorShape>).reason === 'string' &&
    Array.isArray((err as Partial<GuardrailBlockErrorShape>).detections)
  );
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  // Tratamento especial: erros de governança de modelos de IA (T5)
  if (err instanceof ModelGovernanceError) {
    logger.error('[MODEL_GOVERNANCE] Violação de governança de modelo', {
      context: {
        code: err.code,
        details: err.details,
        path: req.path,
      },
    });
    res.status(422).json({
      error: err.name,
      error_code: err.code,
      message: err.message,
      ...err.details,
      statusCode: 422,
      timestamp: new Date().toISOString(),
      path: req.path,
    });
    return;
  }

  // Bloqueio de guardrail: a entrada não passou na verificação de segurança
  // (injection/PII) ou a verificação não pôde ser feita. Sem este tratamento a
  // classe cai no default 500, dando ao usuário "erro interno" para o que é,
  // na verdade, uma rejeição de entrada — e escondendo indisponibilidade real
  // do guardrail atrás da mesma resposta.
  //
  // Duck-typing em vez de `instanceof` para não importar `openai-ai.ts` aqui
  // (mesma razão do bloco de DemandNotFoundError abaixo: dependência circular).
  if (isGuardrailBlockError(err)) {
    // `guardrails_unavailable` é fail-closed por indisponibilidade do próprio
    // guardrail (spec 012/FR-009): a entrada do usuário pode estar perfeita, o
    // servidor é que não consegue verificá-la. Responder 4xx aqui culparia o
    // usuário por uma falha nossa e mascararia um incidente como erro de input.
    const unavailable = err.reason === 'guardrails_unavailable';
    const statusCode = unavailable ? 503 : 422;

    logger.warn('[GUARDRAIL] Requisição bloqueada', {
      context: {
        reason: err.reason,
        detections: err.detections.length,
        statusCode,
        path: req.path,
      },
    });

    const safeDetections = sanitizeDetections(err.detections);
    res.status(statusCode).json({
      error: err.name,
      error_code: unavailable ? 'GUARDRAIL_UNAVAILABLE' : 'GUARDRAIL_BLOCKED',
      message: err.message,
      reason: err.reason,
      detections: safeDetections.types,
      detectionCount: safeDetections.count,
      statusCode,
      timestamp: new Date().toISOString(),
      path: req.path,
    });
    return;
  }

  // Convert Zod errors to ValidationError
  let error: Error | AppError = err;
  if (err instanceof ZodError) {
    error = formatZodError(err);
  }

  // Convert DemandNotFoundError (from DemandRepository) to NotFoundError
  // This avoids importing DemandRepository here (evita dependência circular)
  if (
    err.name === 'DemandNotFoundError' &&
    'statusCode' in err &&
    (err as any).statusCode === 404
  ) {
    error = new NotFoundError('Demanda', (err as any).demandId);
  }

  let statusCode = 500;
  let isOperational = false;
  let errorCode = 'INTERNAL_ERROR';

  if (error instanceof AppError) {
    statusCode = error.statusCode;
    isOperational = error.isOperational;
    errorCode = error.errorCode;
  }

  const isDevelopment = process.env.NODE_ENV === 'development';

  // Log the error
  const logContext = {
    context: {
      path: req.path,
      method: req.method,
      statusCode,
      errorCode,
      isOperational,
      requestId: req.headers['x-request-id'],
      userId: (req as any).user?.id,
    },
    error: err,
  };

  if (statusCode >= 500) {
    logger.error(`[${req.method}] ${req.path} - ${err.message}`, logContext);
  } else if (statusCode >= 400) {
    logger.warn(`[${req.method}] ${req.path} - ${err.message}`, logContext);
  }

  // Format and send response
  const response = formatErrorResponse(error, req, isDevelopment);

  // Add Rate Limit headers if applicable
  if (error instanceof RateLimitError && error.retryAfter) {
    res.setHeader('Retry-After', error.retryAfter.toString());
  }

  res.status(statusCode).json(response);
}

// ============================================
// Async Handler Wrapper
// ============================================

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<any>;

export function asyncHandler(fn: AsyncRequestHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ============================================
// Not Found Handler
// ============================================

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError('Route', req.path));
}

// ============================================
// Request Validation Helper
// ============================================

import { z } from 'zod';

export function validateRequest<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw formatZodError(result.error);
  }
  return result.data;
}

// ============================================
// Helper Functions for Common Operations
// ============================================

export function assertFound<T>(
  value: T | null | undefined,
  resourceName: string,
  id?: string | number,
): asserts value is T {
  if (value === null || value === undefined) {
    throw new NotFoundError(resourceName, id);
  }
}

export function assertAuthorized(
  condition: boolean,
  message: string = 'Access denied',
): asserts condition {
  if (!condition) {
    throw new ForbiddenError(message);
  }
}
