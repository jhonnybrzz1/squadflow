import { db } from '../db';
import { documentSnapshots, documentLifecycleEvents } from '@shared/schema-unified';
import { eq, and } from 'drizzle-orm';

export interface CreateSnapshotInput {
  snapshotId: string;
  demandId: number;
  snapshotType: 'REVIEW' | 'APPROVED';
  payloadJson: string;
  snapshotHash: string;
  createdAt: Date;
}

export interface CreateLifecycleEventInput {
  demandId: number;
  requiresApproval: boolean;
  approvalSessionId?: string;
  eventType: string;
  reviewSnapshotId?: string;
  approvedSnapshotId?: string;
  finalSnapshotId?: string;
  finalizedFromHash?: string;
  resultCode?: string;
  errorMessage?: string;
  createdAt: Date;
}

type DbLike = typeof db;

/**
 * DocumentRepository — Fase 2 (Repository Pattern)
 *
 * Abstração sobre snapshots e eventos de ciclo de vida de documentos,
 * centralizando o acesso a dados da governança.
 */
export class DocumentRepository {
  private client: DbLike;

  constructor(client: DbLike = db) {
    this.client = client;
  }

  /**
   * Cria um snapshot de documento.
   * Aceita um cliente alternativo para uso dentro de transações.
   */
  async createSnapshot(input: CreateSnapshotInput, client: DbLike = this.client) {
    await client.insert(documentSnapshots).values(input);
  }

  /**
   * Busca um snapshot pelo ID e demandId.
   */
  async findSnapshotById(snapshotId: string, demandId: number, client: DbLike = this.client) {
    return client.query.documentSnapshots.findFirst({
      where: and(
        eq(documentSnapshots.snapshotId, snapshotId),
        eq(documentSnapshots.demandId, demandId),
      ),
    });
  }

  /**
   * Busca um snapshot pelo ID (sem verificar demandId).
   */
  async findSnapshot(snapshotId: string, client: DbLike = this.client) {
    return client.query.documentSnapshots.findFirst({
      where: eq(documentSnapshots.snapshotId, snapshotId),
    });
  }

  /**
   * Cria um evento de ciclo de vida.
   * Aceita um cliente alternativo para uso dentro de transações.
   */
  async createLifecycleEvent(input: CreateLifecycleEventInput, client: DbLike = this.client) {
    await client
      .insert(documentLifecycleEvents)
      .values(input as typeof documentLifecycleEvents.$inferInsert);
  }
}

export const documentRepository = new DocumentRepository();
