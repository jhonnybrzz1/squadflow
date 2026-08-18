import fs from 'fs';
import { logger } from '../utils/logger';
import { demandRepository } from '../repositories/demand-repository';
import { v4 as uuidv4 } from 'uuid';
import { DocumentSnapshotService } from './document-snapshot-service';
import { DocumentStateMachine } from './document-state-machine';
import { GovernanceGatingService } from './governance-gating-service';
import type { RefinementInteraction, Demand, CoverageAnalysisResult } from '@shared/schema';
import { dbTransaction, type TransactionCallback } from '../db';
import { approvalComments, demands } from '@shared/schema-unified';
import { documentRepository } from '../repositories/document-repository';
import { documentVersioningService } from './document-versioning';
import { eq } from 'drizzle-orm';

type TxClient = Parameters<TransactionCallback<unknown>>[0];

/**
 * Checks if a demand requires human review based on its flags.
 *
 * @param demand - Demand object with review flags
 * @returns Whether human review is required
 */
export function requiresHumanReview(demand: {
  requiresHumanReview?: boolean | null;
  requiresApproval?: boolean | null;
}): boolean {
  return Boolean(demand.requiresHumanReview ?? demand.requiresApproval);
}

/**
 * Atualiza uma demanda dentro de uma transação.
 * Fallback para o comportamento do storage quando usado fora de uma transação.
 */
async function updateDemandInTx(
  tx: TxClient,
  demandId: number,
  updates: Partial<Demand>,
): Promise<Demand> {
  const [updated] = await tx
    .update(demands)
    .set({ ...updates, updatedAt: new Date() } as Partial<typeof demands.$inferInsert>)
    .where(eq(demands.id, demandId))
    .returning();
  if (!updated) {
    throw new Error('Demand not found');
  }
  return updated as Demand;
}

/**
 * Gets PRD content from a file path.
 *
 * @param prdUrl - Path to PRD file
 * @returns PRD content or empty string
 */
export async function getPrdContent(prdUrl: string | null, demandId?: number): Promise<string> {
  if (demandId !== undefined) {
    try {
      const versioned = await documentVersioningService.load(demandId, 'prd');
      if (versioned.content.trim()) return versioned.content;
    } catch (e) {
      logger.warn(`Could not read versioned PRD for demand ${demandId}`, {
        error: e instanceof Error ? e : undefined,
      });
    }
  }

  if (!prdUrl) return '';
  try {
    if (fs.existsSync(prdUrl)) {
      return fs.readFileSync(prdUrl, 'utf8');
    }
  } catch (e) {
    logger.warn(`Could not read PRD file at ${prdUrl}`, {
      error: e instanceof Error ? e : undefined,
    });
  }
  return '';
}

/**
 * Submits a demand for approval, creating a snapshot and running gating checks.
 *
 * @param demandId - Demand ID
 * @param override - Whether to override gating failures
 * @param overrideJustification - Justification for override
 * @returns Snapshot and approval session data
 */
export async function submitForApproval(
  demandId: number,
  override: boolean = false,
  overrideJustification?: string,
): Promise<{
  snapshot: { snapshotId: string; snapshotHash: string };
  approvalSessionId: string;
  gating: { valid: boolean; errors?: string[]; reasons?: string[] };
  coverage: CoverageAnalysisResult;
}> {
  const demand = await demandRepository.findByIdOrNull(demandId);
  if (!demand) {
    throw new Error('Demand not found');
  }

  const prdContent = await getPrdContent(demand.prdUrl, demandId);
  const gating = GovernanceGatingService.validateStructuralGate(demand, prdContent);

  if (!gating.valid && !override) {
    const details = gating.errors.join(' | ');
    throw new Error(`GATING_FAILED: ${details}`);
  }

  if (override && !overrideJustification) {
    throw new Error('Justificativa de override obrigatória.');
  }

  const coverage = GovernanceGatingService.analyzeCoverage(demand.description, prdContent);

  const validation = DocumentStateMachine.validateTransition(
    demand.documentState || 'DRAFT',
    'submit_for_approval',
    requiresHumanReview(demand),
  );

  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const snapshot = await DocumentSnapshotService.createSnapshot(demand, 'REVIEW');

  const learnings = GovernanceGatingService.generateLearnings(demand.refinementInteractions || []);

  await dbTransaction(async (tx) => {
    await documentRepository.createSnapshot(
      {
        snapshotId: snapshot.snapshotId,
        demandId: snapshot.demandId,
        snapshotType: snapshot.snapshotType,
        payloadJson: snapshot.payloadJson,
        snapshotHash: snapshot.snapshotHash,
        createdAt: snapshot.createdAt,
      },
      tx,
    );

    await updateDemandInTx(tx, demandId, {
      documentState: 'UNDER_REVIEW',
      reviewSnapshotId: snapshot.snapshotId,
      learningLog: learnings,
    });
  });

  const approvalSessionId = uuidv4();

  return {
    snapshot,
    approvalSessionId,
    gating,
    coverage,
  };
}

/**
 * Updates the section checklist for a demand.
 *
 * @param demandId - Demand ID
 * @param checklist - Checklist object
 */
export async function updateChecklist(
  demandId: number,
  checklist: Record<string, boolean>,
): Promise<void> {
  // Auditoria 2026-08-01 (A04): isto substituía o mapa inteiro. Como
  // `DemandListItem` omite `sectionChecklist` e a Home monta a demanda por cast
  // da listagem, o DocumentViewer abria com `{}` e o primeiro clique enviava um
  // mapa quase vazio — apagando de uma vez todas as evidências já persistidas e
  // mudando o score do gate. O merge por chave torna o backend indiferente a um
  // cliente com estado incompleto: só o que veio no payload é alterado, chave
  // ausente nunca some.
  const demand = await demandRepository.findByIdOrNull(demandId);
  const existing = (demand?.sectionChecklist ?? {}) as Record<string, boolean>;

  const merged: Record<string, boolean> = { ...existing };
  for (const [section, checked] of Object.entries(checklist)) {
    // `null` explícito também não apaga: limpar evidência exige ação própria.
    if (checked === null || checked === undefined) continue;
    merged[section] = checked;
  }

  await demandRepository.update(demandId, {
    sectionChecklist: merged,
    updatedAt: new Date(),
  });
}

/**
 * Records a refinement interaction (PROPOSE/ACCEPT/REJECT/COMMENT).
 *
 * @param demandId - Demand ID
 * @param interaction - Interaction data
 * @returns Created interaction
 */
export async function recordInteraction(
  demandId: number,
  interaction: Omit<RefinementInteraction, 'id' | 'timestamp'>,
): Promise<RefinementInteraction> {
  const demand = await demandRepository.findByIdOrNull(demandId);
  if (!demand) {
    throw new Error('Demand not found');
  }

  const newInteraction: RefinementInteraction = {
    ...interaction,
    id: uuidv4(),
    timestamp: new Date().toISOString(),
  };

  const updatedInteractions = [...(demand.refinementInteractions || []), newInteraction];

  await demandRepository.update(demandId, {
    refinementInteractions: updatedInteractions,
    updatedAt: new Date(),
  });

  return newInteraction;
}

/**
 * Approves a demand, validating the snapshot and transitioning state.
 *
 * @param demandId - Demand ID
 * @param reviewSnapshotId - Review snapshot ID
 * @param snapshotHash - Snapshot hash for validation
 * @param comments - Optional approval comments
 * @returns Updated demand state
 */
/**
 * Auditoria 2026-08-01 (A03): normaliza o feedback humano antes de persistir.
 * Comentário só de whitespace vira ausência de comentário, não string vazia.
 */
function normalizeComments(comments?: string): string | undefined {
  const trimmed = comments?.trim();
  return trimmed ? trimmed : undefined;
}

export async function approveDemand(
  demandId: number,
  reviewSnapshotId: string,
  snapshotHash: string,
  // A rota de /approve já persiste o comentário em `approval_comments`.
  _comments?: string,
): Promise<{ documentState: string; approvedAt: Date }> {
  const demand = await demandRepository.findByIdOrNull(demandId);
  if (!demand) {
    throw new Error('Demand not found');
  }

  const validation = DocumentStateMachine.validateApprove(
    demand.documentState || 'DRAFT',
    reviewSnapshotId,
    demand.reviewSnapshotId || null,
  );

  if (!validation.valid) {
    await documentRepository.createLifecycleEvent({
      demandId,
      requiresApproval: true,
      approvalSessionId: demand.approvalSessionId || undefined,
      eventType: validation.error?.includes('SNAPSHOT_OUTDATED')
        ? 'SNAPSHOT_OUTDATED'
        : 'APPROVE_ATTEMPT',
      reviewSnapshotId,
      resultCode: 'REJECTED',
      errorMessage: validation.error,
      createdAt: new Date(),
    });

    throw new Error(validation.error);
  }

  const reviewSnapshot = await documentRepository.findSnapshotById(reviewSnapshotId, demandId);

  if (!reviewSnapshot) {
    throw new Error('Review snapshot not found');
  }

  if (reviewSnapshot.snapshotHash !== snapshotHash) {
    throw new Error(
      'SNAPSHOT_HASH_MISMATCH: Provided snapshotHash does not match the review snapshot',
    );
  }

  if (!DocumentSnapshotService.verifySnapshot(reviewSnapshot)) {
    throw new Error('SNAPSHOT_INTEGRITY_FAILED: Review snapshot integrity check failed');
  }

  const stateMachine = new DocumentStateMachine();
  await stateMachine.transition(demandId, 'APPROVED', {
    author: 'system',
    reason: 'Approved via governance API',
  });

  const approvedAt = new Date();

  await dbTransaction(async (tx) => {
    // Auditoria 2026-08-01 (A02): só `approvedAt`/`approvedBy` eram gravados.
    // `DocumentStateMachine.transition` é log-only (não persiste nada), então a
    // demanda continuava em UNDER_REVIEW e `approvedSnapshotId` ficava null —
    // e `validateFinalize` exige exatamente esse campo. Resultado: /approve
    // respondia APPROVED e /finalize rejeitava por "no approved snapshot",
    // travando o happy path por construção. O snapshot aprovado é o mesmo que
    // acabou de ter hash e integridade verificados acima.
    await updateDemandInTx(tx, demandId, {
      documentState: 'APPROVED',
      approvedSnapshotId: reviewSnapshotId,
      approvedSnapshotHash: reviewSnapshot.snapshotHash,
      approvedAt,
      approvedBy: 'system',
      updatedAt: approvedAt,
    });

    await documentRepository.createLifecycleEvent(
      {
        demandId,
        requiresApproval: true,
        approvalSessionId: demand.approvalSessionId || undefined,
        eventType: 'APPROVED',
        reviewSnapshotId,
        approvedSnapshotId: reviewSnapshotId,
        resultCode: 'SUCCESS',
        createdAt: approvedAt,
      },
      tx,
    );
  });

  return {
    documentState: 'APPROVED',
    approvedAt,
  };
}

/**
 * Rejects a demand, recording the rejection reason.
 *
 * @param demandId - Demand ID
 * @param reason - Rejection reason
 * @returns Updated demand state
 *
 * Exposta em `POST /api/governance/demands/:id/reject` desde 2026-08-07 — o
 * TODO do relatório de dead code de 2026-07-28 (#10269) foi resolvido pela via
 * de expor, não de remover: sem ela dava para aprovar uma demanda e não para
 * rejeitar.
 */
export async function rejectDemand(
  demandId: number,
  reason: string,
): Promise<{ documentState: string; rejectedAt: Date }> {
  const demand = await demandRepository.findByIdOrNull(demandId);
  if (!demand) {
    throw new Error('Demand not found');
  }

  const stateMachine = new DocumentStateMachine();
  await stateMachine.transition(demandId, 'REJECTED', {
    author: 'system',
    reason,
  });

  const rejectedAt = new Date();

  await dbTransaction(async (tx) => {
    await updateDemandInTx(tx, demandId, {
      rejectedAt,
      rejectionReason: reason,
      updatedAt: rejectedAt,
    });

    await documentRepository.createLifecycleEvent(
      {
        demandId,
        requiresApproval: true,
        approvalSessionId: demand.approvalSessionId || undefined,
        eventType: 'REJECTED',
        reviewSnapshotId: demand.reviewSnapshotId || undefined,
        resultCode: 'SUCCESS',
        errorMessage: reason,
        createdAt: rejectedAt,
      },
      tx,
    );
  });

  return {
    documentState: 'REJECTED',
    rejectedAt,
  };
}

/**
 * Requests changes for a demand, returning it to DRAFT state.
 *
 * @param demandId - Demand ID
 * @param reviewSnapshotId - Optional review snapshot ID
 * @param snapshotHash - Optional snapshot hash
 * @param comments - Optional comments
 * @returns Updated demand state
 */
export async function requestChanges(
  demandId: number,
  reviewSnapshotId?: string,
  _snapshotHash?: string,
  comments?: string,
  author?: string,
): Promise<{ documentState: string; returnedToDraftAt: Date }> {
  const demand = await demandRepository.findByIdOrNull(demandId);
  if (!demand) {
    throw new Error('Demand not found');
  }

  const validation = DocumentStateMachine.validateRequestChanges(demand.documentState || 'DRAFT');
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  if (reviewSnapshotId && reviewSnapshotId !== demand.reviewSnapshotId) {
    await documentRepository.createLifecycleEvent({
      demandId,
      requiresApproval: requiresHumanReview(demand),
      approvalSessionId: demand.approvalSessionId || undefined,
      eventType: 'SNAPSHOT_OUTDATED',
      reviewSnapshotId,
      resultCode: 'REJECTED',
      errorMessage: 'SNAPSHOT_OUTDATED: The review snapshot has changed. Please reload.',
      createdAt: new Date(),
    });

    throw new Error('SNAPSHOT_OUTDATED: The review snapshot has changed. Please reload.');
  }

  const stateMachine = new DocumentStateMachine();
  await stateMachine.transition(demandId, 'DRAFT', {
    author: 'system',
    reason: 'Changes requested via governance API',
  });

  const returnedToDraftAt = new Date();

  await dbTransaction(async (tx) => {
    await updateDemandInTx(tx, demandId, {
      documentState: 'DRAFT',
      returnedToDraftAt,
      updatedAt: returnedToDraftAt,
    });

    await documentRepository.createLifecycleEvent(
      {
        demandId,
        requiresApproval: requiresHumanReview(demand),
        approvalSessionId: demand.approvalSessionId || undefined,
        eventType: 'UNDER_REVIEW_TO_DRAFT',
        reviewSnapshotId,
        resultCode: 'SUCCESS',
        createdAt: returnedToDraftAt,
      },
      tx,
    );

    // Auditoria 2026-08-01 (A03): o comentário chegava aqui e era descartado
    // (`_comments`), então o feedback que justifica a volta para DRAFT sumia —
    // justamente o texto que o autor precisa ler antes de reeditar. A rota de
    // /approve já gravava em `approval_comments`; /request-changes não. Grava
    // na MESMA tabela (que já tem rota de leitura e entra nas métricas), e
    // dentro da transação: ou o estado volta para DRAFT com o feedback, ou
    // nenhum dos dois acontece.
    const content = normalizeComments(comments);
    if (content) {
      await tx.insert(approvalComments).values({
        demandId,
        reviewSnapshotId: reviewSnapshotId ?? null,
        approvedSnapshotId: null,
        author: author ?? 'system',
        content,
        createdAt: returnedToDraftAt,
      });
    }
  });

  return {
    documentState: 'DRAFT',
    returnedToDraftAt,
  };
}

/**
 * Finalizes a demand, deriving final content from approved snapshot if required.
 *
 * @param demandId - Demand ID
 * @returns Finalized demand state
 */
export async function finalizeDemand(
  demandId: number,
): Promise<{ documentState: string; finalSnapshotId?: string; finalizedFromHash?: string }> {
  const demand = await demandRepository.findByIdOrNull(demandId);
  if (!demand) {
    throw new Error('Demand not found');
  }

  const validation = DocumentStateMachine.validateFinalize(
    demand.documentState || 'DRAFT',
    requiresHumanReview(demand),
    Boolean(demand.approvedSnapshotId),
  );
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  let finalSnapshotId: string | undefined;
  let finalizedFromHash: string | undefined;

  // If requires approval, derive from approved snapshot
  if (requiresHumanReview(demand) && demand.approvedSnapshotId) {
    const approvedSnapshot = await documentRepository.findSnapshot(demand.approvedSnapshotId);

    if (!approvedSnapshot) {
      throw new Error('Approved snapshot not found');
    }

    if (!DocumentSnapshotService.verifySnapshot(approvedSnapshot)) {
      throw new Error('Approved snapshot integrity check failed');
    }

    finalSnapshotId = approvedSnapshot.snapshotId;
    finalizedFromHash = approvedSnapshot.snapshotHash;

    // INVARIANT CHECK: Ensure finalized hash matches approved hash
    if (finalizedFromHash !== demand.approvedSnapshotHash) {
      logger.error('INVARIANT VIOLATION: Finalized hash does not match approved hash', {
        context: { demandId },
      });

      await documentRepository.createLifecycleEvent({
        demandId,
        requiresApproval: true,
        approvalSessionId: demand.approvalSessionId || undefined,
        eventType: 'FINALIZE_ATTEMPT',
        approvedSnapshotId: demand.approvedSnapshotId,
        finalizedFromHash,
        resultCode: 'ERROR',
        errorMessage: 'Hash mismatch: finalized !== approved',
        createdAt: new Date(),
      });

      throw new Error('Integrity check failed: finalized content does not match approved content');
    }
  }

  const completedAt = new Date();

  await dbTransaction(async (tx) => {
    await updateDemandInTx(tx, demandId, {
      documentState: 'FINAL',
      status: 'completed',
      finalSnapshotId,
      finalizedFromHash,
      completedAt,
      updatedAt: completedAt,
    });

    await documentRepository.createLifecycleEvent(
      {
        demandId,
        requiresApproval: demand.requiresApproval || false,
        approvalSessionId: demand.approvalSessionId || undefined,
        eventType: 'APPROVED_TO_FINAL',
        approvedSnapshotId: demand.approvedSnapshotId || undefined,
        finalSnapshotId,
        finalizedFromHash,
        resultCode: 'SUCCESS',
        createdAt: completedAt,
      },
      tx,
    );
  });

  return {
    documentState: 'FINAL',
    finalSnapshotId,
    finalizedFromHash,
  };
}
