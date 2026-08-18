import { promises as fs } from 'fs';
import type { Request } from 'express';

import { uploadRejectedTotal } from '../metrics';
import { logger } from '../utils/logger';

/**
 * Spec 012 (H-06): orçamento estrutural de upload, validação por assinatura
 * binária real e limpeza garantida de temporários.
 */
export const UPLOAD_BUDGET = {
  maxFileBytes: 10 * 1024 * 1024,
  maxFiles: 10,
  maxParts: 30,
  maxFields: 20,
  maxFieldBytes: 64 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
} as const;

export const MULTER_LIMITS = {
  fileSize: UPLOAD_BUDGET.maxFileBytes,
  files: UPLOAD_BUDGET.maxFiles,
  parts: UPLOAD_BUDGET.maxParts,
  fields: UPLOAD_BUDGET.maxFields,
  fieldSize: UPLOAD_BUDGET.maxFieldBytes,
} as const;

export type UploadRejectionReason = 'multer_limit' | 'budget' | 'signature' | 'zip_bomb';

const TEXT_PROBE_BYTES = 8 * 1024;

function startsWith(buffer: Buffer, signature: number[] | string, offset = 0): boolean {
  const bytes =
    typeof signature === 'string' ? Buffer.from(signature, 'ascii') : Buffer.from(signature);
  if (buffer.length < offset + bytes.length) return false;
  return buffer.subarray(offset, offset + bytes.length).equals(bytes);
}

function looksLikeText(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, TEXT_PROBE_BYTES);
  return !probe.includes(0);
}

/**
 * Valida o tipo declarado contra a assinatura binária real do conteúdo.
 * Tabela de assinaturas em specs/012-seguranca-local-guardrails/data-model.md.
 */
export function matchesDeclaredType(declaredMime: string, head: Buffer): boolean {
  if (head.length === 0) return false;

  switch (declaredMime) {
    case 'image/png':
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47]);
    case 'image/jpeg':
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return startsWith(head, 'GIF87a') || startsWith(head, 'GIF89a');
    case 'image/webp':
      return startsWith(head, 'RIFF') && startsWith(head, 'WEBP', 8);
    case 'image/svg+xml':
      return looksLikeText(head);
    case 'application/pdf':
      return startsWith(head, '%PDF-');
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return startsWith(head, [0x50, 0x4b, 0x03, 0x04]);
    default:
      if (declaredMime.startsWith('text/') || declaredMime === 'application/json') {
        return looksLikeText(head);
      }
      // image/* genérico sem assinatura conhecida: exigir uma das assinaturas de imagem.
      if (declaredMime.startsWith('image/')) {
        return (
          startsWith(head, [0x89, 0x50, 0x4e, 0x47]) ||
          startsWith(head, [0xff, 0xd8, 0xff]) ||
          startsWith(head, 'GIF87a') ||
          startsWith(head, 'GIF89a') ||
          (startsWith(head, 'RIFF') && startsWith(head, 'WEBP', 8))
        );
      }
      return false;
  }
}

export interface UploadValidationResult {
  ok: boolean;
  reason?: UploadRejectionReason;
  offendingFile?: string;
}

/**
 * Valida orçamento total e assinaturas de todos os arquivos do request.
 * Qualquer violação rejeita o request inteiro (fail-closed no upload).
 */
export async function validateUploadedFiles(
  files: Express.Multer.File[],
): Promise<UploadValidationResult> {
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > UPLOAD_BUDGET.maxTotalBytes) {
    return { ok: false, reason: 'budget' };
  }

  for (const file of files) {
    const handle = await fs.open(file.path, 'r');
    try {
      const head = Buffer.alloc(Math.min(TEXT_PROBE_BYTES, file.size || TEXT_PROBE_BYTES));
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      if (!matchesDeclaredType(file.mimetype, head.subarray(0, bytesRead))) {
        return { ok: false, reason: 'signature', offendingFile: file.originalname };
      }
    } finally {
      await handle.close();
    }
  }

  return { ok: true };
}

/** Remove os temporários do multer para o request. Idempotente (ENOENT ignorado). */
export async function cleanupUploadedFiles(req: Request): Promise<void> {
  const files: Express.Multer.File[] = Array.isArray(req.files)
    ? req.files
    : req.files
      ? Object.values(req.files).flat()
      : [];
  if (req.file) files.push(req.file);

  await Promise.all(
    files.map(async (file) => {
      if (!file.path) return;
      try {
        await fs.unlink(file.path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          logger.warn('Falha ao remover temporário de upload', {
            error: error instanceof Error ? error : undefined,
            context: { path: file.path },
          });
        }
      }
    }),
  );
}

export function recordUploadRejection(reason: UploadRejectionReason, fileName?: string): void {
  uploadRejectedTotal.inc({ reason });
  logger.warn('Upload rejeitado', {
    context: { reason, fileName: fileName?.slice(0, 120) },
  });
}
