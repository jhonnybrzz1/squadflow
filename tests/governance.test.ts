import { describe, it, expect, vi } from 'vitest';

// CRIT-9: createSnapshot agora busca o conteúdo real via
// documentVersioningService antes de cair para leitura de arquivo. Nestes
// testes de unidade não há demanda/versão real no banco — mockamos para
// simular "sem versão registrada" e exercitar o fallback (fs, que também
// não encontra os caminhos fictícios usados aqui, resultando em '').
vi.mock('../server/services/document-versioning', () => ({
  documentVersioningService: {
    load: vi.fn().mockRejectedValue(new Error('not found in test')),
  },
}));

import { DocumentSnapshotService } from '../server/services/document-snapshot-service';
import { DocumentStateMachine } from '../server/services/document-state-machine';
import type { Demand } from '@shared/schema';

describe('DocumentSnapshotService', () => {
  const mockDemand: Demand = {
    id: 1,
    title: 'Test Demand',
    description: 'Test Description',
    type: 'nova_funcionalidade',
    priority: 'alta',
    refinementType: null,
    status: 'processing',
    progress: 0,
    chatMessages: [],
    prdUrl: 'test-prd-content',
    tasksUrl: 'test-tasks-content',
    classification: null,
    orchestration: null,
    currentAgent: null,
    errorMessage: null,
    validationNotes: null,
    typeAdherence: null,
    completedAt: null,
    requiresApproval: true,
    requiresHumanReview: true,
    documentState: 'DRAFT',
    reviewSnapshotId: null,
    approvedSnapshotId: null,
    approvedSnapshotHash: null,
    finalSnapshotId: null,
    finalizedFromHash: null,
    approvalSessionId: null,
    revisionNumber: 0,
    reviewRequestedAt: null,
    approvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  describe('createSnapshot', () => {
    it('should create a valid review snapshot', async () => {
      const snapshot = await DocumentSnapshotService.createSnapshot(mockDemand, 'REVIEW');

      expect(snapshot.snapshotId).toBeDefined();
      expect(snapshot.demandId).toBe(1);
      expect(snapshot.snapshotType).toBe('REVIEW');
      expect(snapshot.payloadJson).toBeDefined();
      expect(snapshot.snapshotHash).toBeDefined();
      expect(snapshot.snapshotHash).toHaveLength(64); // SHA-256 hex length
    });

    it('should create deterministic hash for same content', async () => {
      const snapshot1 = await DocumentSnapshotService.createSnapshot(mockDemand, 'REVIEW');
      const snapshot2 = await DocumentSnapshotService.createSnapshot(mockDemand, 'REVIEW');

      // Different snapshot IDs
      expect(snapshot1.snapshotId).not.toBe(snapshot2.snapshotId);

      // But same hash for same content
      expect(snapshot1.snapshotHash).toBe(snapshot2.snapshotHash);
    });

    it('should create different hash for different content', async () => {
      const snapshot1 = await DocumentSnapshotService.createSnapshot(mockDemand, 'REVIEW');

      const modifiedDemand = { ...mockDemand, title: 'Modified Title' };
      const snapshot2 = await DocumentSnapshotService.createSnapshot(modifiedDemand, 'REVIEW');

      expect(snapshot1.snapshotHash).not.toBe(snapshot2.snapshotHash);
    });

    it('CRIT-9: deve armazenar o conteúdo real do documento, não a URL', async () => {
      const snapshot = await DocumentSnapshotService.createSnapshot(mockDemand, 'REVIEW');
      const payload = JSON.parse(snapshot.payloadJson);

      // Sem versão registrada e sem arquivo real no caminho fictício, o
      // conteúdo cai para string vazia — nunca para a URL crua
      // ('test-prd-content'/'test-tasks-content'), que era o bug original.
      expect(payload.prdContent).not.toBe(mockDemand.prdUrl);
      expect(payload.tasksContent).not.toBe(mockDemand.tasksUrl);
    });
  });

  describe('verifySnapshot', () => {
    it('should verify valid snapshot', async () => {
      const snapshot = await DocumentSnapshotService.createSnapshot(mockDemand, 'REVIEW');
      expect(DocumentSnapshotService.verifySnapshot(snapshot)).toBe(true);
    });

    it('should reject tampered snapshot', async () => {
      const snapshot = await DocumentSnapshotService.createSnapshot(mockDemand, 'REVIEW');

      // Tamper with payload
      const tamperedSnapshot = {
        ...snapshot,
        payloadJson: JSON.stringify({ ...JSON.parse(snapshot.payloadJson), title: 'Hacked' }),
      };

      expect(DocumentSnapshotService.verifySnapshot(tamperedSnapshot)).toBe(false);
    });
  });

  describe('compareSnapshots', () => {
    it('should return true for identical content', async () => {
      const snapshot1 = await DocumentSnapshotService.createSnapshot(mockDemand, 'REVIEW');
      const snapshot2 = await DocumentSnapshotService.createSnapshot(mockDemand, 'APPROVED');

      expect(DocumentSnapshotService.compareSnapshots(snapshot1, snapshot2)).toBe(true);
    });

    it('should return false for different content', async () => {
      const snapshot1 = await DocumentSnapshotService.createSnapshot(mockDemand, 'REVIEW');

      const modifiedDemand = { ...mockDemand, description: 'Modified' };
      const snapshot2 = await DocumentSnapshotService.createSnapshot(modifiedDemand, 'REVIEW');

      expect(DocumentSnapshotService.compareSnapshots(snapshot1, snapshot2)).toBe(false);
    });
  });

  describe('validateFinalization', () => {
    it('should validate matching hashes', async () => {
      const snapshot = await DocumentSnapshotService.createSnapshot(mockDemand, 'APPROVED');

      expect(
        DocumentSnapshotService.validateFinalization(snapshot.snapshotHash, snapshot.snapshotHash),
      ).toBe(true);
    });

    it('should reject mismatched hashes', () => {
      expect(DocumentSnapshotService.validateFinalization('hash1', 'hash2')).toBe(false);
    });
  });
});

describe('DocumentStateMachine', () => {
  describe('canTransition', () => {
    it('should allow DRAFT to FINAL without approval', () => {
      expect(DocumentStateMachine.canTransition('DRAFT', 'FINAL', false)).toBe(true);
    });

    it('should allow DRAFT to UNDER_REVIEW with human review', () => {
      expect(DocumentStateMachine.canTransition('DRAFT', 'UNDER_REVIEW', true)).toBe(true);
    });

    it('should allow UNDER_REVIEW to FINAL with approve and finalize', () => {
      expect(DocumentStateMachine.canTransition('UNDER_REVIEW', 'FINAL', true)).toBe(true);
    });

    it('should reject DRAFT to UNDER_REVIEW without human review requirement', () => {
      expect(DocumentStateMachine.canTransition('DRAFT', 'UNDER_REVIEW', false)).toBe(false);
    });

    it('should reject invalid transitions', () => {
      expect(DocumentStateMachine.canTransition('FINAL', 'UNDER_REVIEW', true)).toBe(false);
    });
  });

  describe('getNextActions', () => {
    it('should return finalize for DRAFT without approval', () => {
      const actions = DocumentStateMachine.getNextActions('DRAFT', false);
      expect(actions).toContain('finalize');
      expect(actions).not.toContain('submit_for_approval');
    });

    it('should return submit_for_review for DRAFT with human review', () => {
      const actions = DocumentStateMachine.getNextActions('DRAFT', true);
      expect(actions).toContain('submit_for_review');
      expect(actions).not.toContain('finalize');
    });

    it('should return approve_and_finalize for UNDER_REVIEW', () => {
      const actions = DocumentStateMachine.getNextActions('UNDER_REVIEW', true);
      expect(actions).toContain('approve_and_finalize');
      expect(actions).toContain('request_changes');
    });
  });

  describe('validateTransition', () => {
    it('should validate allowed transition', () => {
      const result = DocumentStateMachine.validateTransition('DRAFT', 'finalize', false);

      expect(result.valid).toBe(true);
      expect(result.targetState).toBe('FINAL');
      expect(result.error).toBeUndefined();
    });

    it('should reject invalid transition with error', () => {
      const result = DocumentStateMachine.validateTransition('FINAL', 'finalize', false);

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.allowedActions).toBeDefined();
    });
  });

  describe('validateFinalize', () => {
    it('should allow finalize without approval requirement', () => {
      const result = DocumentStateMachine.validateFinalize('DRAFT', false, false);
      expect(result.valid).toBe(true);
    });

    it('should reject finalize with approval but no approved snapshot', () => {
      const result = DocumentStateMachine.validateFinalize('UNDER_REVIEW', true, false);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('no approved snapshot exists');
    });

    it('should reject finalize in wrong state', () => {
      const result = DocumentStateMachine.validateFinalize('DRAFT', true, true);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('but is in state');
    });

    it('should allow finalize with approval and approved snapshot', () => {
      const result = DocumentStateMachine.validateFinalize('APPROVED', true, true);
      expect(result.valid).toBe(true);
    });
  });

  describe('validateApprove', () => {
    it('should validate approve in UNDER_REVIEW state', () => {
      const snapshotId = 'test-snapshot-id';
      const result = DocumentStateMachine.validateApprove('UNDER_REVIEW', snapshotId, snapshotId);

      expect(result.valid).toBe(true);
    });

    it('should reject approve in wrong state', () => {
      const result = DocumentStateMachine.validateApprove('DRAFT', 'snapshot-id', 'snapshot-id');

      expect(result.valid).toBe(false);
      expect(result.error).toContain("expected 'UNDER_REVIEW'");
    });

    it('should reject approve with outdated snapshot', () => {
      const result = DocumentStateMachine.validateApprove(
        'UNDER_REVIEW',
        'old-snapshot',
        'new-snapshot',
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain('SNAPSHOT_OUTDATED');
    });
  });

  describe('getStateDescription', () => {
    it('should return description for each state', () => {
      expect(DocumentStateMachine.getStateDescription('DRAFT')).toContain('draft');
      expect(DocumentStateMachine.getStateDescription('UNDER_REVIEW')).toContain('review');
      expect(DocumentStateMachine.getStateDescription('APPROVED')).toContain('approved');
      expect(DocumentStateMachine.getStateDescription('FINAL')).toContain('finalized');
    });
  });

  describe('getActionDescription', () => {
    it('should return description for each action', () => {
      expect(DocumentStateMachine.getActionDescription('finalize')).toContain('Finalize');
      expect(DocumentStateMachine.getActionDescription('submit_for_review')).toContain('Submit');
      expect(DocumentStateMachine.getActionDescription('approve_and_finalize')).toContain(
        'Approve',
      );
      expect(DocumentStateMachine.getActionDescription('request_changes')).toContain('Request');
    });
  });
});

describe('Governance Integration Tests', () => {
  describe('Complete Approval Workflow', () => {
    it('should follow complete workflow from DRAFT to FINAL', async () => {
      const mockDemand: Demand = {
        id: 1,
        title: 'Test',
        description: 'Test',
        type: 'nova_funcionalidade',
        priority: 'alta',
        refinementType: null,
        status: 'processing',
        progress: 0,
        chatMessages: [],
        prdUrl: 'content',
        tasksUrl: 'content',
        classification: null,
        orchestration: null,
        currentAgent: null,
        errorMessage: null,
        validationNotes: null,
        typeAdherence: null,
        completedAt: null,
        requiresApproval: true,
        requiresHumanReview: true,
        documentState: 'DRAFT',
        reviewSnapshotId: null,
        approvedSnapshotId: null,
        approvedSnapshotHash: null,
        finalSnapshotId: null,
        finalizedFromHash: null,
        approvalSessionId: null,
        revisionNumber: 0,
        reviewRequestedAt: null,
        approvedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Step 1: Create review snapshot
      const reviewSnapshot = await DocumentSnapshotService.createSnapshot(mockDemand, 'REVIEW');
      expect(reviewSnapshot.snapshotType).toBe('REVIEW');

      // Step 2: Validate transition to UNDER_REVIEW
      const submitValidation = DocumentStateMachine.validateTransition(
        'DRAFT',
        'submit_for_review',
        true,
      );
      expect(submitValidation.valid).toBe(true);

      // Step 3: Validate approve
      const approveValidation = DocumentStateMachine.validateApprove(
        'UNDER_REVIEW',
        reviewSnapshot.snapshotId,
        reviewSnapshot.snapshotId,
      );
      expect(approveValidation.valid).toBe(true);

      // Step 4: Create approved snapshot
      const approvedSnapshot = await DocumentSnapshotService.createSnapshot(mockDemand, 'APPROVED');
      expect(approvedSnapshot.snapshotType).toBe('APPROVED');

      // Step 5: Validate finalize from approved state
      const finalizeValidation = DocumentStateMachine.validateFinalize('APPROVED', true, true);
      expect(finalizeValidation.valid).toBe(true);

      // Step 6: Validate hash consistency
      expect(
        DocumentSnapshotService.validateFinalization(
          approvedSnapshot.snapshotHash,
          approvedSnapshot.snapshotHash,
        ),
      ).toBe(true);
    });
  });

  describe('Guardrails', () => {
    it('should prevent finalization without approval when required', () => {
      const validation = DocumentStateMachine.validateFinalize(
        'UNDER_REVIEW',
        true,
        false, // No approved snapshot
      );

      expect(validation.valid).toBe(false);
      expect(validation.error).toContain('no approved snapshot exists');
    });

    it('should detect snapshot tampering', async () => {
      const mockDemand: Demand = {
        id: 1,
        title: 'Original',
        description: 'Original',
        type: 'nova_funcionalidade',
        priority: 'alta',
        refinementType: null,
        status: 'processing',
        progress: 0,
        chatMessages: [],
        prdUrl: 'content',
        tasksUrl: 'content',
        classification: null,
        orchestration: null,
        currentAgent: null,
        errorMessage: null,
        validationNotes: null,
        typeAdherence: null,
        completedAt: null,
        requiresApproval: true,
        requiresHumanReview: true,
        documentState: 'DRAFT',
        reviewSnapshotId: null,
        approvedSnapshotId: null,
        approvedSnapshotHash: null,
        finalSnapshotId: null,
        finalizedFromHash: null,
        approvalSessionId: null,
        revisionNumber: 0,
        reviewRequestedAt: null,
        approvedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const originalSnapshot = await DocumentSnapshotService.createSnapshot(mockDemand, 'APPROVED');

      // Simulate tampering
      const tamperedPayload = JSON.parse(originalSnapshot.payloadJson);
      tamperedPayload.title = 'Tampered';
      const tamperedSnapshot = {
        ...originalSnapshot,
        payloadJson: JSON.stringify(tamperedPayload),
      };

      expect(DocumentSnapshotService.verifySnapshot(tamperedSnapshot)).toBe(false);
    });
  });
});
