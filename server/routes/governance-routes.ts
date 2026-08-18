import { Router } from 'express';
import { db, dbTransaction } from '../db';
import {
  demands,
  documentSnapshots,
  approvalComments,
  documentLifecycleEvents,
} from '@shared/schema-unified';
import { type RefinementInteraction, refinementInteractionInputSchema } from '@shared/schema';
import { eq, and, desc } from 'drizzle-orm';
import { demandRepository } from '../repositories/demand-repository';
import { documentRepository } from '../repositories/document-repository';
import {
  authContextMiddleware,
  getAuthorName,
  getOverrideAuthor,
  requireAuth,
  requireRole,
} from '../middleware/auth-stub';
import { z } from 'zod';
import { validateRequest } from '../middleware/validate-request';
import {
  asyncHandler,
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
} from '../middleware/error-handler';
import { paramIdSchema } from '@shared/schema';
import {
  requiresHumanReview,
  submitForApproval,
  updateChecklist,
  recordInteraction,
  approveDemand,
  rejectDemand,
  requestChanges,
  finalizeDemand,
  getPrdContent,
} from '../services/governance-service';
import { GovernanceGatingService } from '../services/governance-gating-service';
import { DocumentStateMachine } from '../services/document-state-machine';
import { DocumentSnapshotService } from '../services/document-snapshot-service';
import { documentEvidenceMetrics } from '../services/document-evidence-metrics';

const router = Router();

/**
 * Auditoria 2026-08-01 (A01): estados em que o documento está congelado e a UI
 * deve ler o snapshot, não o documento vivo.
 */
const FROZEN_DOCUMENT_STATES = ['UNDER_REVIEW', 'APPROVED', 'FINAL'] as const;

type FrozenDocumentState = (typeof FROZEN_DOCUMENT_STATES)[number];

export function isFrozenDocumentState(state: string): state is FrozenDocumentState {
  return (FROZEN_DOCUMENT_STATES as readonly string[]).includes(state);
}

/**
 * Resolve QUAL snapshot representa o documento congelado em cada estado.
 *
 * Antes, a rota devolvia sempre o snapshot de revisão e respondia 400 em FINAL
 * — então o cliente não tinha de onde ler o conteúdo aprovado e caía no
 * documento vivo. O fallback desce a cadeia (final -> aprovado -> revisão)
 * para cobrir demandas anteriores à correção do A02, que chegaram a FINAL sem
 * `approvedSnapshotId` gravado.
 */
export function resolveFrozenSnapshotId(
  state: FrozenDocumentState,
  demand: {
    reviewSnapshotId?: string | null;
    approvedSnapshotId?: string | null;
    finalSnapshotId?: string | null;
  },
): string | null {
  switch (state) {
    case 'UNDER_REVIEW':
      return demand.reviewSnapshotId ?? null;
    case 'APPROVED':
      return demand.approvedSnapshotId ?? demand.reviewSnapshotId ?? null;
    case 'FINAL':
      return demand.finalSnapshotId ?? demand.approvedSnapshotId ?? demand.reviewSnapshotId ?? null;
  }
}

// Apply auth context middleware to all governance routes
router.use(authContextMiddleware);

/**
 * @openapi
 * /api/governance/demands/{id}/submit-for-approval:
 *   post:
 *     tags:
 *       - Governance
 *     summary: Submeter documento para aprovação
 *     description: Valida e submete o documento (PRD) de uma demanda para aprovação, criando um snapshot imutável de revisão.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID da demanda
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               override:
 *                 type: boolean
 *                 description: Ignorar falhas estruturais (apenas para PM/TL)
 *               overrideJustification:
 *                 type: string
 *                 description: Justificativa para ignorar falhas
 *     responses:
 *       200:
 *         description: Documento submetido com sucesso
 *       400:
 *         description: Justificativa obrigatória ausente
 *       403:
 *         description: Documento não atende critérios mínimos (Gating Failed)
 *       404:
 *         description: Demanda não encontrada
 *       409:
 *         description: Transição de estado inválida
 *       500:
 *         description: Erro interno do servidor
 */
const submitForApprovalSchema = z.object({
  params: z.object({ id: z.coerce.number().positive() }),
  body: z.object({
    override: z.boolean().optional(),
    overrideJustification: z.string().optional(),
  }),
});

router.post(
  '/demands/:id/submit-for-approval',
  requireAuth,
  requireRole('reviewer', 'product_manager', 'tech_lead', 'admin'),
  validateRequest(submitForApprovalSchema),
  asyncHandler(async (req, res) => {
    const demandId = parseInt(req.params.id);
    const { override, overrideJustification } = req.body;
    const now = new Date();

    let submitResult;
    try {
      submitResult = await submitForApproval(demandId, override, overrideJustification);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('GATING_FAILED')) {
        const gatingErrors = error.message.replace('GATING_FAILED: ', '').split(' | ');
        throw new AppError(error.message, 403, 'FORBIDDEN', { gatingErrors });
      }
      if (error instanceof Error && error.message.startsWith('Justificativa')) {
        throw new ValidationError(error.message);
      }
      throw error;
    }
    const { snapshot, approvalSessionId, gating, coverage } = submitResult;

    const demand = await demandRepository.findByIdOrNull(demandId);
    if (!demand) {
      throw new NotFoundError('Demand', demandId);
    }

    // Update demand with approval session ID and record lifecycle event atomically
    await dbTransaction(async (tx) => {
      await tx
        .update(demands)
        .set({
          reviewSnapshotId: snapshot.snapshotId,
          approvalSessionId,
          reviewRequestedAt: now,
          updatedAt: now,
          coverageAnalysis: coverage,
          overrideJustification: override ? overrideJustification : null,
          overrideBy: override ? getOverrideAuthor(req) : null,
        })
        .where(eq(demands.id, demandId));

      await documentRepository.createLifecycleEvent(
        {
          demandId,
          requiresApproval: requiresHumanReview(demand),
          approvalSessionId,
          eventType: 'DRAFT_TO_APPROVAL_REQUIRED',
          reviewSnapshotId: snapshot.snapshotId,
          resultCode: 'SUCCESS',
          createdAt: now,
        },
        tx,
      );
    });

    res.json({
      success: true,
      documentState: 'UNDER_REVIEW',
      reviewSnapshotId: snapshot.snapshotId,
      snapshotHash: snapshot.snapshotHash,
      approvalSessionId,
      gatingPassed: gating.valid,
      coverageScore: coverage.score,
    });
  }),
);

/**
 * Update section checklist
 */
const checklistSchema = z.object({
  params: z.object({ id: z.coerce.number().positive() }),
  body: z.object({
    checklist: z.record(z.boolean()),
  }),
});

router.post(
  '/demands/:id/checklist',
  requireAuth,
  requireRole('reviewer', 'product_manager', 'tech_lead', 'admin'),
  validateRequest(checklistSchema),
  asyncHandler(async (req, res) => {
    const demandId = parseInt(req.params.id);
    const { checklist } = req.body;

    await updateChecklist(demandId, checklist);
    res.json({ success: true });
  }),
);

/**
 * Record refinement interaction (PROPOSE/ACCEPT/REJECT)
 */
const interactionSchema = z.object({
  params: z.object({ id: z.coerce.number().positive() }),
  body: refinementInteractionInputSchema,
});

router.post(
  '/demands/:id/interactions',
  requireAuth,
  requireRole('reviewer', 'product_manager', 'tech_lead', 'admin'),
  validateRequest(interactionSchema),
  asyncHandler(async (req, res) => {
    const demandId = parseInt(req.params.id);
    const interaction: Omit<RefinementInteraction, 'id' | 'timestamp'> = {
      ...req.body,
      author: getAuthorName(req),
    };

    const newInteraction = await recordInteraction(demandId, interaction);
    res.json(newInteraction);
  }),
);

/**
 * @openapi
 * /api/governance/demands/{id}/gating-status:
 *   get:
 *     tags:
 *       - Governance
 *     summary: Obter status de verificação de bloqueio (Gating Status)
 *     description: Verifica o status estrutural do documento para determinar se ele atende aos critérios mínimos de governança.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID da demanda
 *     responses:
 *       200:
 *         description: Retorna o status de gating da demanda (validade, cobertura, interações).
 *       404:
 *         description: Demanda não encontrada
 *       500:
 *         description: Erro ao buscar o status de gating
 */
router.get(
  '/demands/:id/gating-status',
  validateRequest(paramIdSchema),
  asyncHandler(async (req, res) => {
    const demandId = parseInt(req.params.id);

    // Use demandRepository (in-memory storage) instead of db.query (SQLite)
    // because demands are stored in MemStorage by default
    const demand = await demandRepository.findByIdOrNull(demandId);

    if (!demand) throw new NotFoundError('Demand', demandId);

    const prdContent = await getPrdContent(demand.prdUrl, demandId);

    // Missing content is pending, never a fictitious approved gate.
    if (!prdContent) {
      return res.json({
        structural: { valid: false, errors: ['PRD ainda não está disponível para revisão.'] },
        coverage: { omittedItems: [], score: 0, analyzedAt: new Date().toISOString() },
        interactionsCount: demand.refinementInteractions?.length || 0,
        documentAvailable: false,
      });
    }

    const gating = GovernanceGatingService.validateStructuralGate(demand, prdContent);
    const coverage = GovernanceGatingService.analyzeCoverage(demand.description, prdContent);

    res.json({
      structural: gating,
      coverage: coverage,
      interactionsCount: demand.refinementInteractions?.length || 0,
      documentAvailable: true,
    });
  }),
);

/**
 * @openapi
 * /api/governance/demands/{id}/approve:
 *   post:
 *     tags:
 *       - Governance
 *     summary: Aprovar documento
 *     description: Aprova a versão atual do documento usando o snapshot de revisão. Isso finaliza a edição da versão do PRD.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID da demanda
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reviewSnapshotId
 *             properties:
 *               reviewSnapshotId:
 *                 type: string
 *                 description: ID do snapshot que está sendo aprovado
 *               comments:
 *                 type: string
 *                 description: Comentários adicionais sobre a aprovação
 *     responses:
 *       200:
 *         description: Documento aprovado com sucesso
 *       400:
 *         description: Faltando reviewSnapshotId
 *       404:
 *         description: Demanda não encontrada
 *       409:
 *         description: Transição de aprovação inválida
 *       500:
 *         description: Erro na verificação do snapshot
 */
const approveSchema = z.object({
  params: z.object({ id: z.coerce.number().positive() }),
  body: z.object({
    reviewSnapshotId: z.string().min(1),
    snapshotHash: z.string().min(1),
    comments: z.string().optional(),
  }),
});

router.post(
  '/demands/:id/approve',
  requireAuth,
  requireRole('reviewer', 'product_manager', 'tech_lead', 'admin'),
  validateRequest(approveSchema),
  asyncHandler(async (req, res) => {
    const demandId = parseInt(req.params.id);
    const { reviewSnapshotId, snapshotHash, comments } = req.body;
    const now = new Date();

    if (!reviewSnapshotId) {
      throw new ValidationError('reviewSnapshotId is required');
    }

    let approval;
    try {
      approval = await approveDemand(demandId, reviewSnapshotId, snapshotHash, comments);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('SNAPSHOT_')) {
        throw new ValidationError(error.message);
      }
      if (error instanceof Error && error.message === 'Demand not found') {
        throw new NotFoundError('Demand', demandId);
      }
      if (error instanceof Error && error.message.includes('validateApprove')) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
    const { documentState, approvedAt } = approval;

    // Save comments if provided
    if (comments) {
      await (db as any).insert(approvalComments).values({
        demandId,
        reviewSnapshotId,
        approvedSnapshotId: null,
        author: getAuthorName(req),
        content: comments,
        createdAt: now,
      });
    }

    res.json({
      success: true,
      documentState,
      approvedAt,
    });
  }),
);

/**
 * Reject a demand, moving the document to REJECTED.
 *
 * Triagem de dead code de 2026-08-07: `rejectDemand` existia no serviço desde
 * sempre, testado e completo, mas sem rota nenhuma — dava para aprovar uma
 * demanda pela API e não para rejeitar. Não era código morto, era metade de um
 * fluxo. Espelha `approve`, com os mesmos papéis exigidos.
 */
const rejectSchema = z.object({
  params: z.object({ id: z.coerce.number().positive() }),
  body: z.object({
    reason: z.string().min(1),
  }),
});

router.post(
  '/demands/:id/reject',
  requireAuth,
  requireRole('reviewer', 'product_manager', 'tech_lead', 'admin'),
  validateRequest(rejectSchema),
  asyncHandler(async (req, res) => {
    const demandId = parseInt(req.params.id);
    const { reason } = req.body;

    let rejection;
    try {
      rejection = await rejectDemand(demandId, reason);
    } catch (error) {
      if (error instanceof Error && error.message === 'Demand not found') {
        throw new NotFoundError('Demand', demandId);
      }
      throw error;
    }

    res.json({
      success: true,
      documentState: rejection.documentState,
      rejectedAt: rejection.rejectedAt,
    });
  }),
);

/**
 * Request changes and return the document to DRAFT.
 */
const requestChangesSchema = z.object({
  params: z.object({ id: z.coerce.number().positive() }),
  body: z.object({
    reviewSnapshotId: z.string().optional(),
    snapshotHash: z.string().optional(),
    comments: z.string().optional(),
  }),
});

router.post(
  '/demands/:id/request-changes',
  requireAuth,
  requireRole('reviewer', 'product_manager', 'tech_lead', 'admin'),
  validateRequest(requestChangesSchema),
  asyncHandler(async (req, res) => {
    const demandId = parseInt(req.params.id);
    const { reviewSnapshotId, snapshotHash, comments } = req.body;

    let result;
    try {
      result = await requestChanges(
        demandId,
        reviewSnapshotId,
        snapshotHash,
        comments,
        getAuthorName(req),
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('SNAPSHOT_')) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
    const { documentState, returnedToDraftAt } = result;

    res.json({
      success: true,
      documentState,
      returnedToDraftAt,
    });
  }),
);

/**
 * Finalize document
 * Derives final content exclusively from approved snapshot
 * GUARDRAIL: Rejects any content payload from client
 */
router.post(
  '/demands/:id/finalize',
  requireAuth,
  requireRole('reviewer', 'product_manager', 'tech_lead', 'admin'),
  validateRequest(paramIdSchema),
  asyncHandler(async (req, res) => {
    const demandId = parseInt(req.params.id);

    // GUARDRAIL: Reject if client sends content fields
    const contentFields = ['prdContent', 'tasksContent', 'description', 'title'];
    const hasContentFields = contentFields.some((field) => req.body[field] !== undefined);

    if (hasContentFields) {
      // Record rejected attempt
      await (db as any).insert(documentLifecycleEvents).values({
        demandId,
        requiresApproval: true,
        eventType: 'FINALIZE_PAYLOAD_REJECTED',
        resultCode: 'REJECTED',
        errorMessage: 'Client sent content fields in finalize request',
        createdAt: new Date(),
      });

      throw new ValidationError('Invalid request: finalize must not contain content fields');
    }

    let finalizeResult;
    try {
      finalizeResult = await finalizeDemand(demandId);
    } catch (error) {
      // Registro de auditoria do ciclo de vida antes de propagar ao errorHandler
      await (db as any).insert(documentLifecycleEvents).values({
        demandId,
        requiresApproval: true,
        eventType: 'FINALIZE_ATTEMPT',
        resultCode: 'ERROR',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        createdAt: new Date(),
      });
      throw error;
    }
    const { documentState, finalSnapshotId, finalizedFromHash } = finalizeResult;

    res.json({
      success: true,
      documentState,
      finalSnapshotId,
      finalizedFromHash,
    });
  }),
);

/**
 * Get review snapshot for display
 * Returns immutable content for review UI
 */
router.get(
  '/demands/:id/review-snapshot',
  validateRequest(paramIdSchema),
  asyncHandler(async (req, res) => {
    const demandId = parseInt(req.params.id);

    const demand = await demandRepository.findByIdOrNull(demandId);

    if (!demand) {
      throw new NotFoundError('Demand', demandId);
    }

    const normalizedState = DocumentStateMachine.normalizeState(demand.documentState || 'DRAFT');

    if (!isFrozenDocumentState(normalizedState)) {
      throw new AppError('Document is not in review state', 400, 'VALIDATION_ERROR', {
        currentState: demand.documentState,
      });
    }

    const frozenSnapshotId = resolveFrozenSnapshotId(normalizedState, demand);

    if (!frozenSnapshotId) {
      throw new AppError('Review snapshot not found', 404, 'NOT_FOUND');
    }

    const snapshot = await db.query.documentSnapshots.findFirst({
      where: eq(documentSnapshots.snapshotId, frozenSnapshotId),
    });

    if (!snapshot) {
      throw new AppError('Snapshot not found', 404, 'NOT_FOUND');
    }

    // Verify integrity
    if (!DocumentSnapshotService.verifySnapshot(snapshot)) {
      throw new AppError('Snapshot integrity check failed', 500, 'INTERNAL_ERROR');
    }

    const payload = DocumentSnapshotService.parsePayload(snapshot);

    res.json({
      snapshot: {
        snapshotId: snapshot.snapshotId,
        snapshotHash: snapshot.snapshotHash,
        createdAt: snapshot.createdAt,
      },
      payload,
      demandInfo: {
        id: demand.id,
        title: demand.title,
        documentState: normalizedState,
        approvalSessionId: demand.approvalSessionId,
        revisionNumber: demand.revisionNumber,
      },
    });
  }),
);

/**
 * Get approval comments for a demand
 */
router.get(
  '/demands/:id/approval-comments',
  asyncHandler(async (req, res) => {
    const demandId = parseInt(req.params.id);

    const comments = await db.query.approvalComments.findMany({
      where: eq(approvalComments.demandId, demandId),
      orderBy: [desc(approvalComments.createdAt)],
    });

    res.json(comments);
  }),
);

/**
 * Get lifecycle events for metrics/debugging
 */
router.get(
  '/demands/:id/lifecycle-events',
  asyncHandler(async (req, res) => {
    const demandId = parseInt(req.params.id);

    const events = await db.query.documentLifecycleEvents.findMany({
      where: eq(documentLifecycleEvents.demandId, demandId),
      orderBy: [desc(documentLifecycleEvents.createdAt)],
    });

    res.json(events);
  }),
);

/**
 * Get governance metrics
 */
router.get(
  '/metrics',
  asyncHandler(async (_req, res) => {
    const allDemands = await demandRepository.findAll();
    const allEvents = await db.query.documentLifecycleEvents.findMany();
    const comments = await db.query.approvalComments.findMany();

    const reviewRequestedEvents = allEvents.filter(
      (event) => event.eventType === 'DRAFT_TO_APPROVAL_REQUIRED',
    );
    const approvedEvents = allEvents.filter(
      (event) => event.eventType === 'APPROVAL_REQUIRED_TO_APPROVED',
    );
    const finalizedEvents = allEvents.filter((event) => event.eventType === 'APPROVED_TO_FINAL');
    const conflictEvents = allEvents.filter((event) => event.resultCode === 'REJECTED');

    const approvalDurations = approvedEvents
      .map((approvedEvent) => {
        const requestedEvent = reviewRequestedEvents.find(
          (event) => event.demandId === approvedEvent.demandId,
        );
        if (!requestedEvent) return null;
        return approvedEvent.createdAt.getTime() - requestedEvent.createdAt.getTime();
      })
      .filter((duration): duration is number => typeof duration === 'number');
    const prdAcceptanceDurations = allDemands
      .map((demand) => {
        if (!demand.createdAt || !demand.approvedAt) return null;
        return new Date(demand.approvedAt).getTime() - new Date(demand.createdAt).getTime();
      })
      .filter((duration): duration is number => typeof duration === 'number');
    const evidenceMetrics = documentEvidenceMetrics.getSummary();

    res.json({
      finalizedDocumentCount: finalizedEvents.length,
      reviewRequestedCount: reviewRequestedEvents.length,
      approvedReviewCount: approvedEvents.length,
      acceptedPrdCount: prdAcceptanceDurations.length,
      reviewAdoptionRate:
        allDemands.length > 0 ? reviewRequestedEvents.length / allDemands.length : 0,
      avgTimeToApprovalMs:
        approvalDurations.length > 0
          ? Math.round(
              approvalDurations.reduce((sum, duration) => sum + duration, 0) /
                approvalDurations.length,
            )
          : 0,
      avgTimeToPrdAcceptedMs:
        prdAcceptanceDurations.length > 0
          ? Math.round(
              prdAcceptanceDurations.reduce((sum, duration) => sum + duration, 0) /
                prdAcceptanceDurations.length,
            )
          : 0,
      invalidFilesBlockedCount: evidenceMetrics.invalidFilesBlockedCount,
      invalidEvidenceBlockedDemandCount: evidenceMetrics.invalidEvidenceBlockedDemandCount,
      recentInvalidEvidenceBlocks: evidenceMetrics.recentInvalidEvidenceBlocks,
      avgCommentsPerReview:
        reviewRequestedEvents.length > 0 ? comments.length / reviewRequestedEvents.length : 0,
      conflictRate: allEvents.length > 0 ? conflictEvents.length / allEvents.length : 0,
      snapshotMismatchCount: allEvents.filter((event) =>
        event.errorMessage?.includes('Hash mismatch'),
      ).length,
      reworkRate: 0,
    });
  }),
);

/**
 * @swagger
 * /api/governance/demands/{id}/snapshots/diff:
 *   get:
 *     summary: Get diff between two snapshots
 *     tags: [Governance]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: integer
 *       - name: from
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *         description: Source snapshot ID
 *       - name: to
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *         description: Target snapshot ID
 *     responses:
 *       200:
 *         description: Diff between snapshots
 *       404:
 *         description: Snapshot not found
 */
const diffQuerySchema = z.object({
  params: z.object({
    id: z.coerce.number().positive(),
  }),
  query: z.object({
    from: z.string().min(1),
    to: z.string().min(1),
  }),
});

router.get(
  '/demands/:id/snapshots/diff',
  validateRequest(diffQuerySchema),
  asyncHandler(async (req, res) => {
    const demandId = parseInt(req.params.id, 10);
    const fromId = req.query.from as string;
    const toId = req.query.to as string;

    // Verify demand exists
    const demand = await demandRepository.findByIdOrNull(demandId);
    if (!demand) {
      throw new NotFoundError('Demand', demandId);
    }

    // Fetch both snapshots
    const [fromSnapshot, toSnapshot] = await Promise.all([
      db.query.documentSnapshots.findFirst({
        where: and(
          eq(documentSnapshots.snapshotId, fromId),
          eq(documentSnapshots.demandId, demandId),
        ),
      }),
      db.query.documentSnapshots.findFirst({
        where: and(
          eq(documentSnapshots.snapshotId, toId),
          eq(documentSnapshots.demandId, demandId),
        ),
      }),
    ]);

    if (!fromSnapshot) {
      throw new AppError('Source snapshot not found', 404, 'NOT_FOUND', { snapshotId: fromId });
    }
    if (!toSnapshot) {
      throw new AppError('Target snapshot not found', 404, 'NOT_FOUND', { snapshotId: toId });
    }

    // Parse payloads
    const fromPayload = DocumentSnapshotService.parsePayload(fromSnapshot as any);
    const toPayload = DocumentSnapshotService.parsePayload(toSnapshot as any);

    // Generate simple diff (line-by-line comparison)
    const changes: {
      field: string;
      type: 'added' | 'removed' | 'modified';
      from?: string;
      to?: string;
    }[] = [];

    // Compare top-level fields
    const fieldsToCompare = ['title', 'description', 'prdContent', 'tasksContent'] as const;
    for (const field of fieldsToCompare) {
      const fromValue = fromPayload[field];
      const toValue = toPayload[field];
      if (fromValue !== toValue) {
        changes.push({
          field,
          type: !fromValue ? 'added' : !toValue ? 'removed' : 'modified',
          from: fromValue,
          to: toValue,
        });
      }
    }

    // Compare metadata fields
    if (fromPayload.metadata.refinementType !== toPayload.metadata.refinementType) {
      changes.push({
        field: 'metadata.refinementType',
        type: 'modified',
        from: fromPayload.metadata.refinementType ?? undefined,
        to: toPayload.metadata.refinementType ?? undefined,
      });
    }

    res.json({
      demandId,
      fromSnapshot: {
        snapshotId: fromSnapshot.snapshotId,
        snapshotType: fromSnapshot.snapshotType,
        snapshotHash: fromSnapshot.snapshotHash,
        createdAt: fromSnapshot.createdAt,
      },
      toSnapshot: {
        snapshotId: toSnapshot.snapshotId,
        snapshotType: toSnapshot.snapshotType,
        snapshotHash: toSnapshot.snapshotHash,
        createdAt: toSnapshot.createdAt,
      },
      changes,
      hasChanges: changes.length > 0,
    });
  }),
);

/**
 * @swagger
 * /api/governance/demands/{id}/snapshots:
 *   get:
 *     summary: Get all snapshots for a demand
 *     tags: [Governance]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of snapshots
 *       404:
 *         description: Demand not found
 */
router.get(
  '/demands/:id/snapshots',
  validateRequest(paramIdSchema),
  asyncHandler(async (req, res) => {
    const demandId = parseInt(req.params.id, 10);

    // Verify demand exists
    const demand = await demandRepository.findByIdOrNull(demandId);
    if (!demand) {
      throw new NotFoundError('Demand', demandId);
    }

    // Fetch all snapshots for this demand
    const snapshots = await db.query.documentSnapshots.findMany({
      where: eq(documentSnapshots.demandId, demandId),
      orderBy: [desc(documentSnapshots.createdAt)],
    });

    res.json({
      demandId,
      snapshots: snapshots.map((s) => ({
        snapshotId: s.snapshotId,
        snapshotType: s.snapshotType,
        snapshotHash: s.snapshotHash,
        createdAt: s.createdAt,
      })),
      count: snapshots.length,
    });
  }),
);

export default router;
