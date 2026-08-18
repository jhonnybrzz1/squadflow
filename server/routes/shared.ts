import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import fs from 'fs';
import { logger } from '../utils/logger';
import { RefinementInputError } from '../services/refinement-input';
import {
  cleanupUploadedFiles as cleanupRequestUploads,
  MULTER_LIMITS,
  recordUploadRejection,
  validateUploadedFiles,
} from '../services/upload-budget';
import { REST_SAFE_REMOVED_FIELDS, type RestSafeDemand } from '../../shared/demand-list';
import { AppError, ValidationError } from '../middleware/error-handler';
import type { Demand } from '@shared/schema';
import type { DemandListItem } from '@shared/demand-list';

export {
  refinementTypeSchema,
  createDemandPayloadSchema,
  type CreateDemandPayload,
  parseInsertDemand,
} from '../services/demand-start-contract';

const ALLOWED_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/html',
  'text/csv',
  'text/javascript',
  'text/typescript',
  'application/json',
  'application/xml',
  'application/pdf',
  'application/octet-stream',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

function isAllowedMimeType(mimetype: string): boolean {
  if (ALLOWED_MIME_TYPES.has(mimetype)) return true;
  if (mimetype.startsWith('text/')) return true;
  if (mimetype.startsWith('image/')) return true;
  return false;
}

export const upload = multer({
  dest: 'uploads/',
  // Spec 012 (H-06): orçamento estrutural completo — não apenas fileSize.
  limits: MULTER_LIMITS,
  fileFilter: (_req, file, cb) => {
    if (isAllowedMimeType(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de arquivo não permitido: ${file.mimetype}`));
    }
  },
});

/**
 * Spec 012 (H-06): middleware pós-multer — orçamento total, assinatura
 * binária real e limpeza garantida em erro/abort. Deve ser montado
 * imediatamente após `upload.array(...)`.
 */
export function enforceUploadBudget() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const files = (req.files as Express.Multer.File[]) || [];

    // Abort da conexão: remover temporários mesmo sem resposta.
    req.on('aborted', () => {
      void cleanupRequestUploads(req);
    });

    if (files.length === 0) {
      next();
      return;
    }

    try {
      const result = await validateUploadedFiles(files);
      if (!result.ok) {
        recordUploadRejection(result.reason ?? 'budget', result.offendingFile);
        await cleanupRequestUploads(req);
        const status = result.reason === 'signature' ? 422 : 413;
        res
          .status(status)
          .json({ error: result.reason === 'signature' ? 'unsupported_file' : 'upload_limit' });
        return;
      }
      next();
    } catch (error) {
      await cleanupRequestUploads(req);
      next(error);
    }
  };
}

/**
 * Converte erros do multer (limites estruturais) em 413 `upload_limit`
 * e garante limpeza de temporários em qualquer erro da cadeia de upload.
 */
export function uploadErrorHandler() {
  return (err: unknown, req: Request, res: Response, next: NextFunction) => {
    void cleanupRequestUploads(req).finally(() => {
      if (err instanceof multer.MulterError) {
        recordUploadRejection('multer_limit');
        res.status(413).json({ error: 'upload_limit' });
        return;
      }
      next(err);
    });
  };
}

export { resolveDemandStartContract } from '../services/demand-start-contract';

/**
 * Converte falhas de criação de demanda em AppError para o pipeline central,
 * preservando os status codes históricos (422 RefinementInputError, 400 Zod
 * e 400 genérico) — ver FR-011 da spec 005-friendly-error-responses.
 */
export function toDemandCreationError(error: unknown): Error {
  if (error instanceof RefinementInputError) {
    return new AppError(error.message, 422, error.errorCode, {
      refinementInputSource: 'document',
      documentTextLength: 0,
      ideaTextLength: 0,
    });
  }

  if (error instanceof z.ZodError) {
    const issues = error.errors.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    logger.warn('Invalid demand data: Zod validation failed', { context: { issues } });
    return new ValidationError('Invalid demand data', issues);
  }

  return new ValidationError('Invalid demand data');
}

export function cleanupUploadedFiles(files: Express.Multer.File[] = []): void {
  for (const file of files) {
    // CRIT-18: log em vez de engolir silenciosamente.
    fs.promises.unlink(file.path).catch((err) => {
      logger.warn('Failed to cleanup uploaded file', {
        error: err instanceof Error ? err : undefined,
        context: { path: file.path, filename: file.filename },
      });
    });
  }
}

export function isPdfBytesAsText(content: string): boolean {
  return content.trimStart().startsWith('%PDF-');
}

/**
 * Autenticação administrativa foi removida: o projeto roda apenas localmente.
 * Mantida para compatibilidade com rotas legadas, sempre permitindo acesso.
 */
export function validateAdminKey(_req: Request): boolean {
  return true;
}

/**
 * H-14: Projects a demand row to the DemandListItem contract for SSE.
 * chatMessages are excluded (SSE streams progress, not full conversation
 * history) and the derived counters used by the list/detail views are
 * materialized so the client receives a consistent snapshot.
 */
export function toSseSafeDemand(demand: Demand): DemandListItem {
  const {
    chatMessages,
    learningLog: _learningLog,
    qaEvidence: _qaEvidence,
    originalDescription: _originalDescription,
    maxEffortOverrideDias: _maxEffortOverrideDias,
    maxEffortOverrideBy: _maxEffortOverrideBy,
    maxEffortOverrideJustification: _maxEffortOverrideJustification,
    classification: _classification,
    orchestration,
    refinementInteractions: _refinementInteractions,
    sectionChecklist: _sectionChecklist,
    coverageAnalysis: _coverageAnalysis,
    documentVersions: _documentVersions,
    ...rest
  } = demand;
  const messages = Array.isArray(chatMessages) ? chatMessages : [];

  const timeToAcceptMs =
    rest.approvedAt && rest.createdAt
      ? new Date(rest.approvedAt).getTime() - new Date(rest.createdAt).getTime()
      : null;

  const timeWaitingReviewMs =
    rest.reviewRequestedAt && !rest.approvedAt
      ? Date.now() - new Date(rest.reviewRequestedAt).getTime()
      : null;

  const executionPlanSize =
    (orchestration as { plan?: { agentExecutionOrder?: string[] } } | undefined)?.plan
      ?.agentExecutionOrder?.length || 7;

  return {
    ...rest,
    chatMessageCount: messages.length,
    completedMessageCount: messages.filter((message) => message.type === 'completed').length,
    executionPlanSize,
    timeToAcceptMs,
    timeWaitingReviewMs,
  };
}

/**
 * H-18: Projects a demand row for the GET /api/demands/:id REST endpoint.
 * Broader than toSseSafeDemand because this is an explicit client fetch
 * (not a progress stream) — the client needs chatMessages, classification,
 * orchestration, and governance fields for the detail view. But we still
 * exclude purely internal fields that no client code reads: snapshot hashes
 * (reviewSnapshotId, approvedSnapshotId, finalSnapshotId, etc.), approval
 * session internals, cost telemetry internals (runId, promptTokens,
 * completionTokens), and the learning log.
 */
export function toRestSafeDemand(demand: Demand): RestSafeDemand {
  const excluded = new Set<string>(REST_SAFE_REMOVED_FIELDS);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(demand)) {
    if (!excluded.has(key)) {
      result[key] = value;
    }
  }
  return result as RestSafeDemand;
}
