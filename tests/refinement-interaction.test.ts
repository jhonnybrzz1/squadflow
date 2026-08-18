/**
 * Tests for Interactive Refinement (Polling MVP)
 *
 * Covers contract: docs/refinement-interaction-contract.md
 * - Idempotency
 * - 409 PAUSED
 * - 409 CONTEXT_MISMATCH
 * - Suggestions versioned by contextVersion
 * - Pause/Resume cycle
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory demand store for tests
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

import {
  refinementInteractionService,
  RefinementInteractionError,
} from '../server/services/refinement-interaction';

const REFINEMENT_ID = '42';

function seedDemand() {
  mockDemands = {
    42: {
      id: 42,
      title: 'Test',
      description: 'Test',
      type: 'melhoria',
      refinementInteractions: [],
    },
  };
}

describe('Refinement Interaction Service', () => {
  beforeEach(() => {
    seedDemand();
    refinementInteractionService.reset();
  });

  describe('getStatus', () => {
    it('returns ACTIVE with sequence=0 for fresh demand', async () => {
      const status = await refinementInteractionService.getStatus(REFINEMENT_ID);
      expect(status.status).toBe('ACTIVE');
      expect(status.sequence).toBe(0);
      expect(status.activeInteraction).toBeNull();
      expect(status.pausedAt).toBeNull();
    });

    it('throws NOT_FOUND for unknown demand', async () => {
      await expect(refinementInteractionService.getStatus('999')).rejects.toThrow(
        RefinementInteractionError,
      );
    });
  });

  describe('askQuestion -> applyResponse (happy path)', () => {
    it('emits question and resolves on PO answer', async () => {
      const promise = refinementInteractionService.askQuestion(
        REFINEMENT_ID,
        'Performance ou usabilidade?',
        ['Performance', 'Usabilidade'],
      );

      // Allow event loop to persist
      await new Promise((r) => setImmediate(r));

      const status = await refinementInteractionService.getStatus(REFINEMENT_ID);
      expect(status.activeInteraction).not.toBeNull();
      expect(status.activeInteraction!.question).toBe('Performance ou usabilidade?');
      expect(status.sequence).toBe(1);

      const result = await refinementInteractionService.applyResponse(
        REFINEMENT_ID,
        status.activeInteraction!.interactionId,
        status.sequence,
        'Performance',
      );
      expect(result.applied).toBe(true);
      expect(result.newSequence).toBe(2);

      const answer = await promise;
      expect(answer).toBe('Performance');
    });
  });

  describe('Idempotency', () => {
    it('returns 200 on duplicate response with same payload', async () => {
      const promise = refinementInteractionService.askQuestion(REFINEMENT_ID, 'Q?');
      await new Promise((r) => setImmediate(r));

      const status = await refinementInteractionService.getStatus(REFINEMENT_ID);
      const interactionId = status.activeInteraction!.interactionId;

      const r1 = await refinementInteractionService.applyResponse(
        REFINEMENT_ID,
        interactionId,
        status.sequence,
        'Yes',
      );
      const r2 = await refinementInteractionService.applyResponse(
        REFINEMENT_ID,
        interactionId,
        status.sequence,
        'Yes',
      );

      expect(r1.applied).toBe(true);
      expect(r2.applied).toBe(true);
      expect(r1.newSequence).toBe(r2.newSequence);

      await promise;
    });

    it('throws CONTEXT_MISMATCH on duplicate with different response', async () => {
      const promise = refinementInteractionService.askQuestion(REFINEMENT_ID, 'Q?');
      await new Promise((r) => setImmediate(r));

      const status = await refinementInteractionService.getStatus(REFINEMENT_ID);
      const interactionId = status.activeInteraction!.interactionId;

      await refinementInteractionService.applyResponse(
        REFINEMENT_ID,
        interactionId,
        status.sequence,
        'Yes',
      );

      await expect(
        refinementInteractionService.applyResponse(
          REFINEMENT_ID,
          interactionId,
          status.sequence,
          'Different',
        ),
      ).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });

      await promise;
    });
  });

  describe('Pause / Resume', () => {
    it('pause sets status=PAUSED and increments sequence', async () => {
      const result = await refinementInteractionService.pause(REFINEMENT_ID, 'Reviewing');
      expect(result.status).toBe('PAUSED');
      expect(result.sequence).toBe(1);
      expect(result.pausedAt).toBeTruthy();

      const status = await refinementInteractionService.getStatus(REFINEMENT_ID);
      expect(status.status).toBe('PAUSED');
    });

    it('pause is idempotent', async () => {
      const r1 = await refinementInteractionService.pause(REFINEMENT_ID);
      const r2 = await refinementInteractionService.pause(REFINEMENT_ID);
      expect(r1.sequence).toBe(r2.sequence);
    });

    it('resume sets status=ACTIVE and increments sequence', async () => {
      await refinementInteractionService.pause(REFINEMENT_ID);
      const result = await refinementInteractionService.resume(REFINEMENT_ID);
      expect(result.status).toBe('ACTIVE');
      expect(result.sequence).toBe(2);
    });
  });

  describe('409 PAUSED', () => {
    it('rejects applyResponse when paused', async () => {
      // Setup: question first, then pause
      const promise = refinementInteractionService.askQuestion(REFINEMENT_ID, 'Q?');
      await new Promise((r) => setImmediate(r));
      const beforePause = await refinementInteractionService.getStatus(REFINEMENT_ID);

      await refinementInteractionService.pause(REFINEMENT_ID);

      await expect(
        refinementInteractionService.applyResponse(
          REFINEMENT_ID,
          beforePause.activeInteraction!.interactionId,
          beforePause.sequence,
          'Yes',
        ),
      ).rejects.toMatchObject({ code: 'PAUSED', statusCode: 409 });

      // cleanup pending promise
      promise.catch(() => {});
    });
  });

  describe('409 CONTEXT_MISMATCH', () => {
    it('rejects with stale sequence after resume', async () => {
      const promise = refinementInteractionService.askQuestion(REFINEMENT_ID, 'Q?');
      await new Promise((r) => setImmediate(r));
      const stale = await refinementInteractionService.getStatus(REFINEMENT_ID);
      const staleId = stale.activeInteraction!.interactionId;
      const staleSeq = stale.sequence;

      await refinementInteractionService.pause(REFINEMENT_ID);
      await refinementInteractionService.resume(REFINEMENT_ID);

      await expect(
        refinementInteractionService.applyResponse(REFINEMENT_ID, staleId, staleSeq, 'Yes'),
      ).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });

      promise.catch(() => {});
    });

    it('rejects with unknown interactionId', async () => {
      await expect(
        refinementInteractionService.applyResponse(REFINEMENT_ID, 'unknown-id', 0, 'Yes'),
      ).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
    });
  });

  describe('Suggestions (contextVersion)', () => {
    it('addSuggestion uses current sequence as contextVersion', async () => {
      await refinementInteractionService.pause(REFINEMENT_ID);
      await refinementInteractionService.resume(REFINEMENT_ID);
      const status1 = await refinementInteractionService.getStatus(REFINEMENT_ID);

      const sug = await refinementInteractionService.addSuggestion(REFINEMENT_ID, 'Add a11y tests');
      expect(sug.contextVersion).toBe(status1.sequence);

      const status2 = await refinementInteractionService.getStatus(REFINEMENT_ID);
      expect(status2.suggestions).toHaveLength(1);
      expect(status2.suggestions[0].contextVersion).toBe(status1.sequence);
    });

    it('drops stale suggestions when sequence advances', async () => {
      await refinementInteractionService.addSuggestion(REFINEMENT_ID, 'old');
      await refinementInteractionService.pause(REFINEMENT_ID);
      await refinementInteractionService.resume(REFINEMENT_ID);
      // After resume, sequence advanced; adding new suggestion should drop old ones
      const newSug = await refinementInteractionService.addSuggestion(REFINEMENT_ID, 'new');

      const status = await refinementInteractionService.getStatus(REFINEMENT_ID);
      expect(status.suggestions).toHaveLength(1);
      expect(status.suggestions[0].id).toBe(newSug.id);
      expect(status.suggestions[0].contextVersion).toBe(status.sequence);
    });
  });

  describe('isPaused / waitWhilePaused', () => {
    it('isPaused reflects current state', async () => {
      expect(await refinementInteractionService.isPaused(REFINEMENT_ID)).toBe(false);
      await refinementInteractionService.pause(REFINEMENT_ID);
      expect(await refinementInteractionService.isPaused(REFINEMENT_ID)).toBe(true);
      await refinementInteractionService.resume(REFINEMENT_ID);
      expect(await refinementInteractionService.isPaused(REFINEMENT_ID)).toBe(false);
    });
  });
});
