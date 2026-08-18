import crypto from 'crypto';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { Demand, ChatMessage, TypeAdherenceResult, DocumentType } from '@shared/schema';
import { logger } from '../utils/logger';
import { documentVersioningService } from './document-versioning';

export interface DocumentSnapshot {
  snapshotId: string;
  demandId: number;
  snapshotType: 'REVIEW' | 'APPROVED';
  payloadJson: string;
  snapshotHash: string;
  createdAt: Date;
}

export type { ChatMessage, TypeAdherenceResult };

export interface ClassificationMetadata {
  zone?: string;
  confidence?: number;
  method?: string;
  [key: string]: unknown;
}

export interface OrchestrationMetadata {
  selectedFramework?: string;
  selectedAgent?: string;
  steps?: string[];
  [key: string]: unknown;
}

export interface SnapshotPayload {
  demandId: number;
  title: string;
  description: string;
  type: string;
  priority: string;
  prdContent: string;
  tasksContent: string;
  chatMessages: ChatMessage[];
  metadata: {
    refinementType: string | null;
    typeAdherence: TypeAdherenceResult | null;
    classification: ClassificationMetadata | null;
    orchestration: OrchestrationMetadata | null;
  };
}

/**
 * CRIT-9: resolve o conteúdo REAL de um documento (prd/tasks/tdd) para o
 * snapshot de governança. `demand.prdUrl`/`tasksUrl` guardam apenas o
 * caminho/URL do artefato — gravá-los como se fossem o conteúdo invalidava
 * toda a garantia de imutabilidade (o hash não mudava quando o texto do PRD
 * mudava, e um diff/approve comparava URLs, não o documento).
 *
 * Mesma ordem de resolução usada por `getPrdContent` (governance-service) e
 * `resolveRefinementMarkdown` (routes/artifacts): primeiro a versão
 * registrada em `documentVersions` (documentVersioningService), com
 * fallback para leitura direta do arquivo em `url` (retrocompat).
 */
async function loadRenderedDocumentContent(
  demandId: number,
  url: string | null,
  type: DocumentType,
): Promise<string> {
  try {
    const versioned = await documentVersioningService.load(demandId, type);
    if (versioned.content.trim()) return versioned.content;
  } catch (err) {
    logger.warn(`Falha ao carregar versão registrada do documento (${type}) para snapshot`, {
      error: err instanceof Error ? err : undefined,
      context: { demandId, type },
    });
  }

  if (!url) return '';
  try {
    if (fs.existsSync(url)) {
      return fs.readFileSync(url, 'utf8');
    }
  } catch (err) {
    logger.warn(`Falha ao ler arquivo do documento (${type}) para snapshot`, {
      error: err instanceof Error ? err : undefined,
      context: { demandId, type, url },
    });
  }
  return '';
}

/**
 * Document Snapshot Service
 *
 * Manages immutable snapshots for document review and approval.
 * Ensures deterministic content for governance workflow.
 */
export class DocumentSnapshotService {
  /**
   * Creates an immutable snapshot from a demand
   *
   * @param demand - The demand to snapshot
   * @param snapshotType - Type of snapshot (REVIEW or APPROVED)
   * @returns DocumentSnapshot with unique ID and hash
   */
  static async createSnapshot(
    demand: Demand,
    snapshotType: 'REVIEW' | 'APPROVED',
  ): Promise<DocumentSnapshot> {
    const snapshotId = uuidv4();

    // CRIT-9: busca o conteúdo real dos documentos (não a URL) para que o
    // hash do snapshot reflita o texto efetivamente revisado/aprovado.
    const [prdContent, tasksContent] = await Promise.all([
      loadRenderedDocumentContent(demand.id, demand.prdUrl, 'prd'),
      loadRenderedDocumentContent(demand.id, demand.tasksUrl, 'tasks'),
    ]);

    // Create payload with rendered/derived content
    const payload: SnapshotPayload = {
      demandId: demand.id,
      title: demand.title,
      description: demand.description,
      type: demand.type,
      priority: demand.priority,
      prdContent,
      tasksContent,
      chatMessages: demand.chatMessages || [],
      metadata: {
        refinementType: demand.refinementType,
        typeAdherence: demand.typeAdherence,
        classification: demand.classification,
        orchestration: demand.orchestration,
      },
    };

    const payloadJson = JSON.stringify(payload, null, 0); // No whitespace for consistency
    const snapshotHash = this.generateHash(payloadJson);

    return {
      snapshotId,
      demandId: demand.id,
      snapshotType,
      payloadJson,
      snapshotHash,
      createdAt: new Date(),
    };
  }

  /**
   * Generates deterministic SHA-256 hash of content
   *
   * @param content - Content to hash
   * @returns Hex string hash
   */
  static generateHash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /**
   * Verifies snapshot integrity by comparing hash
   *
   * @param snapshot - Snapshot to verify
   * @returns true if hash matches content
   */
  static verifySnapshot(snapshot: DocumentSnapshot): boolean {
    const calculatedHash = this.generateHash(snapshot.payloadJson);
    return snapshot.snapshotHash === calculatedHash;
  }

  /**
   * Compares two snapshots by hash
   *
   * @param snapshot1 - First snapshot
   * @param snapshot2 - Second snapshot
   * @returns true if snapshots are identical
   */
  static compareSnapshots(snapshot1: DocumentSnapshot, snapshot2: DocumentSnapshot): boolean {
    return snapshot1.snapshotHash === snapshot2.snapshotHash;
  }

  /**
   * Parses snapshot payload JSON
   *
   * @param snapshot - Snapshot to parse
   * @returns Parsed payload object
   */
  static parsePayload(snapshot: DocumentSnapshot): SnapshotPayload {
    try {
      return JSON.parse(snapshot.payloadJson);
    } catch (err) {
      // CRIT-6: um payload corrompido/truncado não deve virar um SyntaxError
      // cru subindo até o handler da rota — logamos com o snapshotId para
      // investigação e devolvemos um erro claro (rotas usam asyncHandler, que
      // já converte a exceção numa resposta 500 controlada).
      logger.error('Falha ao parsear payload do snapshot de documento', {
        error: err instanceof Error ? err : undefined,
        context: { snapshotId: snapshot.snapshotId, demandId: snapshot.demandId },
      });
      throw new Error(`Corrupted snapshot payload (snapshotId=${snapshot.snapshotId})`, {
        cause: err instanceof Error ? err : undefined,
      });
    }
  }

  /**
   * Validates that finalized content matches approved snapshot
   *
   * @param finalizedHash - Hash of finalized content
   * @param approvedHash - Hash of approved snapshot
   * @returns true if hashes match
   */
  static validateFinalization(finalizedHash: string, approvedHash: string): boolean {
    return finalizedHash === approvedHash;
  }
}
