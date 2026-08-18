/**
 * Document State Machine
 *
 * Manages document lifecycle states and validates transitions
 * according to optional human-review governance requirements.
 */

import { logger } from '../utils/logger';

export type DocumentState = 'DRAFT' | 'UNDER_REVIEW' | 'APPROVED' | 'FINAL' | 'APPROVAL_REQUIRED';

type CanonicalDocumentState = 'DRAFT' | 'UNDER_REVIEW' | 'APPROVED' | 'FINAL';

export interface StateTransition {
  from: CanonicalDocumentState;
  to: CanonicalDocumentState;
  action: string;
  requiresHumanReview: boolean;
}

export const ALLOWED_TRANSITIONS: StateTransition[] = [
  {
    from: 'DRAFT',
    to: 'FINAL',
    action: 'finalize',
    requiresHumanReview: false,
  },
  {
    from: 'DRAFT',
    to: 'UNDER_REVIEW',
    action: 'submit_for_review',
    requiresHumanReview: true,
  },
  {
    from: 'DRAFT',
    to: 'UNDER_REVIEW',
    action: 'submit_for_approval',
    requiresHumanReview: true,
  },
  {
    from: 'UNDER_REVIEW',
    to: 'APPROVED',
    action: 'approve',
    requiresHumanReview: true,
  },
  {
    from: 'UNDER_REVIEW',
    to: 'FINAL',
    action: 'approve_and_finalize',
    requiresHumanReview: true,
  },
  {
    from: 'UNDER_REVIEW',
    to: 'DRAFT',
    action: 'request_changes',
    requiresHumanReview: true,
  },
  {
    from: 'APPROVED',
    to: 'FINAL',
    action: 'finalize',
    requiresHumanReview: true,
  },
  {
    from: 'FINAL',
    to: 'DRAFT',
    action: 'reopen',
    requiresHumanReview: false,
  },
];

export interface TransitionValidation {
  valid: boolean;
  targetState?: CanonicalDocumentState;
  error?: string;
  allowedActions?: string[];
}

export class DocumentStateMachine {
  /**
   * Registra (auditoria) uma transição de estado de documento. A persistência
   * do novo estado é feita pelo chamador (demandRepository.update); este método
   * serve como ponto único de log/auditoria da transição.
   */
  async transition(
    demandId: number,
    targetState: DocumentState | string,
    meta: { author: string; reason: string },
  ): Promise<void> {
    logger.info('Document state transition', {
      context: {
        demandId,
        targetState,
        author: meta.author,
        reason: meta.reason,
      },
    });
  }

  static normalizeState(state: DocumentState | string | null | undefined): CanonicalDocumentState {
    if (state === 'APPROVAL_REQUIRED') return 'UNDER_REVIEW';
    if (state === 'UNDER_REVIEW' || state === 'APPROVED' || state === 'FINAL') return state;
    return 'DRAFT';
  }

  static canTransition(
    currentState: DocumentState,
    targetState: DocumentState,
    requiresHumanReview: boolean,
  ): boolean {
    const from = this.normalizeState(currentState);
    const to = this.normalizeState(targetState);

    return ALLOWED_TRANSITIONS.some(
      (t) => t.from === from && t.to === to && t.requiresHumanReview === requiresHumanReview,
    );
  }

  static getNextActions(currentState: DocumentState, requiresHumanReview: boolean): string[] {
    const from = this.normalizeState(currentState);

    return ALLOWED_TRANSITIONS.filter(
      (t) => t.from === from && t.requiresHumanReview === requiresHumanReview,
    ).map((t) => t.action);
  }

  static validateTransition(
    currentState: DocumentState,
    action: string,
    requiresHumanReview: boolean,
  ): TransitionValidation {
    const from = this.normalizeState(currentState);
    const transition = ALLOWED_TRANSITIONS.find(
      (t) =>
        t.from === from && t.action === action && t.requiresHumanReview === requiresHumanReview,
    );

    if (!transition) {
      const allowedActions = this.getNextActions(currentState, requiresHumanReview);

      return {
        valid: false,
        error: `Invalid transition: action '${action}' not allowed in state '${from}' (requiresHumanReview: ${requiresHumanReview})`,
        allowedActions,
      };
    }

    return {
      valid: true,
      targetState: transition.to,
    };
  }

  static validateFinalize(
    currentState: DocumentState,
    requiresHumanReview: boolean,
    hasApprovedSnapshot: boolean,
  ): TransitionValidation {
    const normalizedState = this.normalizeState(currentState);

    if (requiresHumanReview && !hasApprovedSnapshot) {
      return {
        valid: false,
        error: 'Cannot finalize: document requires human review but no approved snapshot exists',
        allowedActions:
          normalizedState === 'DRAFT'
            ? ['submit_for_review']
            : this.getNextActions(currentState, true),
      };
    }

    if (requiresHumanReview && normalizedState !== 'APPROVED') {
      return {
        valid: false,
        error: `Cannot finalize: document requires human review but is in state '${normalizedState}'`,
        allowedActions: this.getNextActions(currentState, true),
      };
    }

    return this.validateTransition(currentState, 'finalize', requiresHumanReview);
  }

  static validateApprove(
    currentState: DocumentState,
    reviewSnapshotId: string,
    currentReviewSnapshotId: string | null,
  ): TransitionValidation {
    const normalizedState = this.normalizeState(currentState);

    if (normalizedState !== 'UNDER_REVIEW') {
      return {
        valid: false,
        error: `Cannot approve: document is in state '${normalizedState}', expected 'UNDER_REVIEW'`,
        allowedActions: this.getNextActions(currentState, true),
      };
    }

    if (reviewSnapshotId !== currentReviewSnapshotId) {
      return {
        valid: false,
        error: 'SNAPSHOT_OUTDATED: The review snapshot has changed. Please reload.',
        allowedActions: ['reload'],
      };
    }

    return {
      valid: true,
      targetState: 'APPROVED',
    };
  }

  static validateRequestChanges(currentState: DocumentState): TransitionValidation {
    const normalizedState = this.normalizeState(currentState);

    if (normalizedState !== 'UNDER_REVIEW') {
      return {
        valid: false,
        error: `Cannot request changes: document is in state '${normalizedState}', expected 'UNDER_REVIEW'`,
        allowedActions: this.getNextActions(currentState, true),
      };
    }

    return {
      valid: true,
      targetState: 'DRAFT',
    };
  }

  static getStateDescription(state: DocumentState): string {
    const descriptions: Record<CanonicalDocumentState, string> = {
      DRAFT: 'Document is in draft mode and can be edited',
      UNDER_REVIEW: 'Document is under human review and awaiting a decision',
      APPROVED: 'Document was approved and can be finalized from the approved snapshot',
      FINAL: 'Document has been finalized and is read-only',
    };
    return descriptions[this.normalizeState(state)];
  }

  static getActionDescription(action: string): string {
    const descriptions: Record<string, string> = {
      finalize: 'Finalize document directly or from an approved snapshot',
      submit_for_review: 'Submit document for human review',
      submit_for_approval: 'Submit document for human review',
      approve: 'Approve reviewed content',
      approve_and_finalize: 'Approve reviewed content and finalize document',
      request_changes: 'Request changes and return document to draft',
      reopen: 'Reopen finalized document for editing',
    };
    return descriptions[action] || action;
  }
}
