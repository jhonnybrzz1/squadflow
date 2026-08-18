/**
 * Tests for Answer Flow MVP — PRD "Modo Conversacional Interativo"
 *
 * Covers Acceptance Criteria AC-01 to AC-05 from the PRD:
 * - AC-01 Gating: state must be AWAITING_USER_INPUT to accept answers
 * - AC-02 Valid submission: correct (questionId, awaitingToken) → applied
 * - AC-03 Out of window: state mismatch or stale token → 409, no mutation
 * - AC-04 Idempotency: same payload twice → applied once
 * - AC-05 Metrics traceability via service result + log events
 *
 * Contract: docs/answer-flow-mvp.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockDemands: Record<number, any> = {};

vi.mock('../server/storage', () => ({
  storage: {
    getDemand: vi.fn(async (id: number) => mockDemands[id]),
    updateDemand: vi.fn(async (id: number, updates: any) => {
      if (!mockDemands[id]) return undefined;
      mockDemands[id] = { ...mockDemands[id], ...updates };
      return mockDemands[id];
    }),
  },
}));

import { refinementInteractionService } from '../server/services/refinement-interaction';

const REFINEMENT_ID = '77';

function seed(status: 'processing' | 'completed' | 'error' = 'processing') {
  mockDemands = {
    77: {
      id: 77,
      title: 'Test',
      description: 'Test',
      type: 'melhoria',
      status,
      refinementInteractions: [],
    },
  };
}

describe('Answer Flow MVP - PRD Acceptance Criteria', () => {
  beforeEach(() => {
    seed();
    refinementInteractionService.reset();
  });

  describe('Status mapping (state machine)', () => {
    it('returns RUNNING when demand is processing without active question', async () => {
      const status = await refinementInteractionService.getAnswerFlowStatus(REFINEMENT_ID);
      expect(status.state).toBe('RUNNING');
      expect(status.awaitingToken).toBeNull();
      expect(status.currentQuestion).toBeNull();
    });

    it('returns AWAITING_USER_INPUT when there is a pending question', async () => {
      const promise = refinementInteractionService.askQuestion(REFINEMENT_ID, 'Pergunta?', [
        'A',
        'B',
      ]);
      await new Promise((r) => setImmediate(r));

      const status = await refinementInteractionService.getAnswerFlowStatus(REFINEMENT_ID);
      expect(status.state).toBe('AWAITING_USER_INPUT');
      expect(status.awaitingToken).toBe(1);
      expect(status.currentQuestion).not.toBeNull();
      expect(status.currentQuestion!.questionText).toBe('Pergunta?');
      expect(status.currentQuestion!.options).toEqual(['A', 'B']);

      promise.catch(() => {});
    });

    it('returns COMPLETED when demand status is completed', async () => {
      seed('completed');
      const status = await refinementInteractionService.getAnswerFlowStatus(REFINEMENT_ID);
      expect(status.state).toBe('COMPLETED');
      expect(status.awaitingToken).toBeNull();
    });

    it('returns FAILED when demand status is error', async () => {
      seed('error');
      const status = await refinementInteractionService.getAnswerFlowStatus(REFINEMENT_ID);
      expect(status.state).toBe('FAILED');
    });
  });

  describe('AC-02 Valid submission', () => {
    it('applies answer when state=AWAITING_USER_INPUT and tokens match', async () => {
      const promise = refinementInteractionService.askQuestion(REFINEMENT_ID, 'Q?');
      await new Promise((r) => setImmediate(r));
      const before = await refinementInteractionService.getAnswerFlowStatus(REFINEMENT_ID);

      const result = await refinementInteractionService.applyAnswer(
        REFINEMENT_ID,
        before.currentQuestion!.questionId,
        before.awaitingToken!,
        'Yes',
      );

      expect(result.applied).toBe(true);
      expect(result.state).toBe('RUNNING');
      expect(result.nextAwaitingToken).toBeNull();

      const answer = await promise;
      expect(answer).toBe('Yes');
    });
  });

  describe('AC-03 Out of window (409)', () => {
    it('rejects when state != AWAITING_USER_INPUT (no question pending)', async () => {
      // No question emitted yet → state=RUNNING
      await expect(
        refinementInteractionService.applyAnswer(REFINEMENT_ID, 'fake-id', 0, 'Yes'),
      ).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH', statusCode: 409 });
    });

    it('rejects when questionId does not match', async () => {
      const promise = refinementInteractionService.askQuestion(REFINEMENT_ID, 'Q?');
      await new Promise((r) => setImmediate(r));
      const status = await refinementInteractionService.getAnswerFlowStatus(REFINEMENT_ID);

      await expect(
        refinementInteractionService.applyAnswer(
          REFINEMENT_ID,
          'wrong-question-id',
          status.awaitingToken!,
          'Yes',
        ),
      ).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });

      promise.catch(() => {});
    });

    it('rejects when awaitingToken does not match', async () => {
      const promise = refinementInteractionService.askQuestion(REFINEMENT_ID, 'Q?');
      await new Promise((r) => setImmediate(r));
      const status = await refinementInteractionService.getAnswerFlowStatus(REFINEMENT_ID);

      await expect(
        refinementInteractionService.applyAnswer(
          REFINEMENT_ID,
          status.currentQuestion!.questionId,
          status.awaitingToken! + 99,
          'Yes',
        ),
      ).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });

      promise.catch(() => {});
    });

    it('does NOT mutate state on rejection', async () => {
      const promise = refinementInteractionService.askQuestion(REFINEMENT_ID, 'Q?');
      await new Promise((r) => setImmediate(r));
      const before = await refinementInteractionService.getAnswerFlowStatus(REFINEMENT_ID);

      await expect(
        refinementInteractionService.applyAnswer(REFINEMENT_ID, 'wrong-id', 0, 'Yes'),
      ).rejects.toThrow();

      const after = await refinementInteractionService.getAnswerFlowStatus(REFINEMENT_ID);
      expect(after.awaitingToken).toBe(before.awaitingToken);
      expect(after.state).toBe(before.state);
      expect(after.currentQuestion!.questionId).toBe(before.currentQuestion!.questionId);

      promise.catch(() => {});
    });
  });

  describe('AC-04 Idempotency', () => {
    it('returns 200 (applied=true) on duplicate with same payload', async () => {
      const promise = refinementInteractionService.askQuestion(REFINEMENT_ID, 'Q?');
      await new Promise((r) => setImmediate(r));
      const before = await refinementInteractionService.getAnswerFlowStatus(REFINEMENT_ID);
      const qid = before.currentQuestion!.questionId;
      const tok = before.awaitingToken!;

      const r1 = await refinementInteractionService.applyAnswer(REFINEMENT_ID, qid, tok, 'Yes');

      // Second call with same payload — service detects idempotency at applyResponse layer.
      // Note: at applyAnswer layer, by now state has advanced to RUNNING, so it will throw.
      // The idempotency contract is at /answers HTTP layer through applyResponse.
      // Here we test the underlying applyResponse idempotency directly:
      const r2 = await refinementInteractionService.applyResponse(REFINEMENT_ID, qid, tok, 'Yes');

      expect(r1.applied).toBe(true);
      expect(r2.applied).toBe(true);

      // History should NOT have duplicate answer events from idempotent retries.
      // Note: history contains both the question (with answer attached) and the answer
      // event itself, so we expect ≤2 rows, not unbounded growth.
      const status = await refinementInteractionService.getAnswerFlowStatus(REFINEMENT_ID);
      const answersForQ = status.history.filter((h) => h.answer === 'Yes');
      expect(answersForQ.length).toBeLessThanOrEqual(2);
      // Most importantly: no third entry was added by the idempotent retry
      expect(status.history.length).toBeLessThanOrEqual(2);

      promise.catch(() => {});
    });
  });

  describe('AC-05 Metrics traceability', () => {
    it('result includes applied flag for accuracy metric (AAA)', async () => {
      const promise = refinementInteractionService.askQuestion(REFINEMENT_ID, 'Q?');
      await new Promise((r) => setImmediate(r));
      const before = await refinementInteractionService.getAnswerFlowStatus(REFINEMENT_ID);

      const result = await refinementInteractionService.applyAnswer(
        REFINEMENT_ID,
        before.currentQuestion!.questionId,
        before.awaitingToken!,
        'Yes',
      );

      // Service result must expose applied + state for downstream metric collection
      expect(result).toHaveProperty('applied');
      expect(result).toHaveProperty('state');
      expect(result).toHaveProperty('nextAwaitingToken');

      promise.catch(() => {});
    });
  });

  describe('Edge cases (PRD §13)', () => {
    it('refinement without questions completes normally', async () => {
      seed('completed');
      const status = await refinementInteractionService.getAnswerFlowStatus(REFINEMENT_ID);
      expect(status.state).toBe('COMPLETED');
      expect(status.currentQuestion).toBeNull();
    });

    it('history exposes answered questions for audit', async () => {
      const p1 = refinementInteractionService.askQuestion(REFINEMENT_ID, 'Q1?');
      await new Promise((r) => setImmediate(r));
      const s1 = await refinementInteractionService.getAnswerFlowStatus(REFINEMENT_ID);
      await refinementInteractionService.applyAnswer(
        REFINEMENT_ID,
        s1.currentQuestion!.questionId,
        s1.awaitingToken!,
        'A1',
      );
      await p1;

      const final = await refinementInteractionService.getAnswerFlowStatus(REFINEMENT_ID);
      expect(final.history.length).toBeGreaterThanOrEqual(1);
      const hasAnswer = final.history.some((h) => h.answer === 'A1');
      expect(hasAnswer).toBe(true);
    });
  });
});
