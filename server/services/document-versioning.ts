import { resolvePath } from '@shared/utils/paths';
/**
 * Document Versioning Service (MVP - PRD "Editor de Documentos")
 *
 * Hybrid persistence:
 * - Content: file on disk (documents/<Type>_<demandId>_<timestamp>.md)
 * - Metadata (version, hash, previousContent): JSON column documentVersions on demands table
 *
 * Concurrency: optimistic via ifMatchVersion → 412 Precondition Failed on
 * mismatch OR when ifMatchVersion is absent for an existing document (Bug 4).
 *
 * Contract: docs/document-editor-contract.md
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { demandRepository } from '../repositories/demand-repository';
import { AppError } from '../middleware/error-handler';
import type { DocumentType, DocumentVersionInfo, DocumentVersionsMap } from '@shared/schema';

type DocumentVersionErrorCode =
  'VERSION_CONFLICT' | 'NO_PREVIOUS_VERSION' | 'NOT_FOUND' | 'INVALID_CONTENT';

// Bug 4: DocumentVersionError agora estende AppError para que o error-handler
// central respeite seu statusCode (antes virava 500, e o payload de conflito
// nunca chegava ao cliente). VERSION_CONFLICT usa 412 Precondition Failed —
// tanto para ifMatchVersion incorreto quanto ausente num documento existente.
export class DocumentVersionError extends AppError {
  readonly code: DocumentVersionErrorCode;
  readonly serverVersion?: number;
  readonly serverContent?: string;
  readonly serverUpdatedAt?: string;
  readonly clientVersion?: number;

  constructor(
    code: DocumentVersionErrorCode,
    message: string,
    extra?: {
      serverVersion?: number;
      serverContent?: string;
      serverUpdatedAt?: string;
      clientVersion?: number;
    },
  ) {
    const statusCode =
      code === 'NOT_FOUND'
        ? 404
        : code === 'INVALID_CONTENT'
          ? 400
          : code === 'VERSION_CONFLICT'
            ? 412
            : 409; // NO_PREVIOUS_VERSION
    super(message, statusCode, code, extra ? { ...extra } : undefined);
    this.name = 'DocumentVersionError';
    this.code = code;
    Object.assign(this, extra || {});
    Object.setPrototypeOf(this, DocumentVersionError.prototype);
  }
}

const DOCUMENTS_DIR = resolvePath('documents');

function ensureDocumentsDir(): void {
  if (!fs.existsSync(DOCUMENTS_DIR)) {
    fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
  }
}

function sha256(content: string): string {
  return 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');
}

function buildFilename(demandId: number, type: DocumentType, version: number): string {
  const upper = type === 'prd' ? 'PRD' : 'Tasks';
  return `${upper}_${demandId}_v${version}.md`;
}

function isTextDocumentFile(filename: string): boolean {
  return filename.endsWith('.md') || filename.endsWith('.txt');
}

function isPdfBytesAsText(content: string): boolean {
  return content.trimStart().startsWith('%PDF-');
}

export interface LoadResult {
  demandId: number;
  type: DocumentType;
  content: string;
  version: number;
  hash: string;
  updatedAt: string;
  hasPreviousVersion: boolean;
}

export interface SaveResult {
  success: true;
  version: number;
  hash: string;
  updatedAt: string;
}

export class DocumentVersioningService {
  /**
   * Load current document content + metadata.
   * If no metadata exists yet but a legacy file is found, returns version=0 (initial).
   */
  async load(demandId: number, type: DocumentType): Promise<LoadResult> {
    const demand = await demandRepository.findByIdOrNull(demandId);
    if (!demand) {
      throw new DocumentVersionError('NOT_FOUND', `Demand ${demandId} not found`);
    }

    const versions = (demand.documentVersions || {}) as DocumentVersionsMap;
    const meta = versions[type];

    if (!meta) {
      // Legacy fallback: try to find the most recent file for this demand+type
      ensureDocumentsDir();
      const upper = type === 'prd' ? 'PRD' : 'Tasks';
      const prefix = `${upper}_${demandId}_`;
      let legacyContent = '';
      try {
        const files = fs
          .readdirSync(DOCUMENTS_DIR)
          .filter((f) => f.startsWith(prefix) && isTextDocumentFile(f));
        if (files.length > 0) {
          // Pick the most recent by mtime
          const sorted = files
            .map((f) => ({
              name: f,
              mtime: fs.statSync(path.join(DOCUMENTS_DIR, f)).mtime.getTime(),
            }))
            .sort((a, b) => b.mtime - a.mtime);
          legacyContent = fs.readFileSync(path.join(DOCUMENTS_DIR, sorted[0].name), 'utf8');
          if (isPdfBytesAsText(legacyContent)) {
            legacyContent = '';
          }
        }
      } catch (err) {
        logger.warn('Failed to load legacy document', {
          error: err instanceof Error ? err : undefined,
          context: { demandId, type },
        });
      }

      return {
        demandId,
        type,
        content: legacyContent,
        version: 0,
        hash: legacyContent ? sha256(legacyContent) : '',
        updatedAt: new Date(0).toISOString(),
        hasPreviousVersion: false,
      };
    }

    // Read current content from disk
    ensureDocumentsDir();
    const filename = buildFilename(demandId, type, meta.version);
    const filepath = path.join(DOCUMENTS_DIR, filename);
    let content = '';
    if (fs.existsSync(filepath)) {
      content = fs.readFileSync(filepath, 'utf8');
      if (isPdfBytesAsText(content)) {
        logger.warn('Document version content is PDF bytes, ignoring as editable content', {
          context: { demandId, type, version: meta.version, filename },
        });
        content = '';
      }
    } else {
      logger.warn('Document file missing on disk', {
        context: { demandId, type, version: meta.version, filename },
      });
    }

    return {
      demandId,
      type,
      content,
      version: meta.version,
      hash: meta.hash,
      updatedAt: meta.updatedAt,
      hasPreviousVersion: meta.previousVersion !== undefined,
    };
  }

  /**
   * Save new version with optimistic concurrency.
   *
   * @param ifMatchVersion expected current version; required when document
   *   exists. Absent (undefined) on an existing document is a precondition
   *   failure → 412 (Bug 4), not a 400 validation error.
   * @param force when true, skips version check (used by conflict modal "overwrite" action)
   */
  async save(
    demandId: number,
    type: DocumentType,
    content: string,
    ifMatchVersion: number | undefined,
    force = false,
  ): Promise<SaveResult> {
    if (typeof content !== 'string') {
      throw new DocumentVersionError('INVALID_CONTENT', 'content must be a string');
    }

    const demand = await demandRepository.findByIdOrNull(demandId);
    if (!demand) {
      throw new DocumentVersionError('NOT_FOUND', `Demand ${demandId} not found`);
    }

    const versions = ((demand.documentVersions || {}) as DocumentVersionsMap) ?? {};
    const meta = versions[type];
    const currentVersion = meta?.version ?? 0;

    // Concurrency check (skipped when force=true). Bug 4: ifMatchVersion ausente
    // (undefined) num documento existente é precondition failure — cai no mesmo
    // ramo de VERSION_CONFLICT (412) que um valor incorreto.
    if (!force && meta && ifMatchVersion !== currentVersion) {
      // Read server content for the conflict response
      let serverContent = '';
      try {
        const filename = buildFilename(demandId, type, meta.version);
        const filepath = path.join(DOCUMENTS_DIR, filename);
        if (fs.existsSync(filepath)) {
          serverContent = fs.readFileSync(filepath, 'utf8');
        }
      } catch (_) {
        /* swallow */
      }

      logger.info('Document save conflict', {
        context: {
          demandId,
          type,
          clientVersion: ifMatchVersion,
          serverVersion: currentVersion,
          eventType: 'document_save_conflict',
        },
      });

      throw new DocumentVersionError('VERSION_CONFLICT', 'Document changed since last load', {
        serverVersion: currentVersion,
        serverContent,
        serverUpdatedAt: meta.updatedAt,
        clientVersion: ifMatchVersion,
      });
    }

    // Idempotency: if content hash matches current, skip write
    const newHash = sha256(content);
    if (meta && meta.hash === newHash) {
      return {
        success: true,
        version: meta.version,
        hash: meta.hash,
        updatedAt: meta.updatedAt,
      };
    }

    // Capture previous content for revert
    let previousContent: string | undefined;
    if (meta) {
      try {
        const prevFile = path.join(DOCUMENTS_DIR, buildFilename(demandId, type, meta.version));
        if (fs.existsSync(prevFile)) {
          previousContent = fs.readFileSync(prevFile, 'utf8');
        }
      } catch (_) {
        /* swallow */
      }
    }

    // Prepare new version metadata before writing the file. CRIT-12: metadata
    // is persisted first so the DB always points at the authoritative on-disk
    // version. If the subsequent file write fails, we roll the metadata back to
    // the previous version so load() never points at a missing file. The
    // opposite case (orphan file without metadata) is no longer possible.
    const newVersion = currentVersion + 1;
    ensureDocumentsDir();
    const newFilename = buildFilename(demandId, type, newVersion);
    const newFilepath = path.join(DOCUMENTS_DIR, newFilename);
    const updatedAt = new Date().toISOString();
    const newMeta: DocumentVersionInfo = {
      version: newVersion,
      hash: newHash,
      updatedAt,
      previousVersion: meta?.version,
      previousHash: meta?.hash,
      previousContent,
    };
    const newVersions: DocumentVersionsMap = { ...versions, [type]: newMeta };

    try {
      await demandRepository.update(demandId, { documentVersions: newVersions });
    } catch (err) {
      throw err;
    }

    try {
      fs.writeFileSync(newFilepath, content, 'utf8');
    } catch (err) {
      try {
        await demandRepository.update(demandId, { documentVersions: versions });
      } catch (rollbackErr) {
        logger.error('Failed to roll back document metadata after file write failure', {
          error: rollbackErr instanceof Error ? rollbackErr : undefined,
          context: { demandId, type, newVersion, newFilename },
        });
      }
      throw err;
    }

    logger.info('Document saved', {
      context: {
        demandId,
        type,
        version: newVersion,
        forced: force,
        eventType: force ? 'document_save_forced' : 'document_saved',
      },
    });

    return { success: true, version: newVersion, hash: newHash, updatedAt };
  }

  /**
   * Revert to last saved version (1-back).
   */
  async revert(
    demandId: number,
    type: DocumentType,
  ): Promise<SaveResult & { revertedFromVersion: number }> {
    const demand = await demandRepository.findByIdOrNull(demandId);
    if (!demand) {
      throw new DocumentVersionError('NOT_FOUND', `Demand ${demandId} not found`);
    }
    const versions = (demand.documentVersions || {}) as DocumentVersionsMap;
    const meta = versions[type];
    if (!meta || meta.previousContent === undefined || meta.previousVersion === undefined) {
      throw new DocumentVersionError('NO_PREVIOUS_VERSION', 'No previous version available');
    }

    const fromVersion = meta.version;
    // Save previousContent as a NEW version (linear history)
    const result = await this.save(demandId, type, meta.previousContent, meta.version, true);

    logger.info('Document reverted', {
      context: {
        demandId,
        type,
        fromVersion,
        toVersion: result.version,
        eventType: 'document_reverted',
      },
    });

    return { ...result, revertedFromVersion: fromVersion };
  }
}

export const documentVersioningService = new DocumentVersioningService();
