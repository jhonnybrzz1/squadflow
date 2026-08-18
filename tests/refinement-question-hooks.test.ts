/**
 * Tests for Refinement Question Hooks
 *
 * Verifies that:
 * - Hooks are no-op when feature flag is OFF
 * - Heuristics correctly identify when to ask
 * - Timeouts gracefully fall through (asked=false)
 * - Hooks integrate with refinement-interaction service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  askIfDescriptionTooShort,
  askIfBugMissingExpectedBehavior,
  askIfCriticalWithoutDeadline,
  runClarificationHooks,
} from '../server/services/refinement-question-hooks';
import { refinementInteractionService } from '../server/services/refinement-interaction';
import type { Demand } from '@shared/schema';

function makeDemand(overrides: Partial<Demand> = {}): Demand {
  const id = (overrides.id as number) ?? 100;
  mockDemands[id] = {
    id,
    title: 'Test',
    description: 'Curta demais',
    type: 'nova_funcionalidade',
    priority: 'media',
    status: 'processing',
    progress: 0,
    refinementInteractions: [],
    ...overrides,
  };
  return mockDemands[id] as Demand;
}

describe('Refinement Question Hooks', () => {
  beforeEach(() => {
    mockDemands = {};
    refinementInteractionService.reset();
    delete process.env.REFINEMENT_INTERACTIVE_QUESTIONS_ENABLED;
    delete process.env.REFINEMENT_QUESTION_TIMEOUT_MS;
  });

  afterEach(() => {
    delete process.env.REFINEMENT_INTERACTIVE_QUESTIONS_ENABLED;
    delete process.env.REFINEMENT_QUESTION_TIMEOUT_MS;
  });

  describe('Feature flag', () => {
    it('returns asked=false when flag is OFF (default)', async () => {
      const demand = makeDemand({ description: 'curta' });
      const result = await askIfDescriptionTooShort(demand);
      expect(result.asked).toBe(false);
      expect(result.reason).toBe('disabled_by_flag');
    });

    it('runClarificationHooks short-circuits when flag is OFF', async () => {
      const demand = makeDemand({ description: 'curta' });
      const results = await runClarificationHooks(demand);
      expect(results).toHaveLength(1);
      expect(results[0].reason).toBe('disabled_by_flag');
    });
  });

  describe('askIfDescriptionTooShort', () => {
    beforeEach(() => {
      process.env.REFINEMENT_INTERACTIVE_QUESTIONS_ENABLED = 'true';
      process.env.REFINEMENT_QUESTION_TIMEOUT_MS = '50'; // fast timeout for tests
    });

    it('skips when type is not nova_funcionalidade', async () => {
      const demand = makeDemand({ type: 'bug', description: 'curta' });
      const result = await askIfDescriptionTooShort(demand);
      expect(result.asked).toBe(false);
      expect(result.reason).toBe('not_new_feature');
    });

    it('skips when description is long enough', async () => {
      const longDesc = Array(40).fill('palavra').join(' ');
      const demand = makeDemand({ type: 'nova_funcionalidade', description: longDesc });
      const result = await askIfDescriptionTooShort(demand);
      expect(result.asked).toBe(false);
      expect(result.reason).toBe('description_long_enough');
    });

    it('asks when nova_funcionalidade has short description (timeout flow)', async () => {
      const demand = makeDemand({
        id: 101,
        type: 'nova_funcionalidade',
        description: 'Adicionar botão',
      });
      const result = await askIfDescriptionTooShort(demand);
      // With 50ms timeout, no PO will answer → asked=false with reason=timeout
      expect(result.asked).toBe(false);
      expect(result.reason).toBe('timeout');
    });

    it('resolves when PO answers in time', async () => {
      process.env.REFINEMENT_QUESTION_TIMEOUT_MS = '5000';
      const demand = makeDemand({
        id: 102,
        type: 'nova_funcionalidade',
        description: 'Adicionar botão',
      });

      // Kick off the hook
      const hookPromise = askIfDescriptionTooShort(demand);

      // Wait for question to be persisted, then answer
      await new Promise((r) => setTimeout(r, 10));
      const status = await refinementInteractionService.getAnswerFlowStatus('102');
      expect(status.state).toBe('AWAITING_USER_INPUT');

      await refinementInteractionService.applyAnswer(
        '102',
        status.currentQuestion!.questionId,
        status.awaitingToken!,
        'Performance',
      );

      const result = await hookPromise;
      expect(result.asked).toBe(true);
      expect(result.answer).toBe('Performance');
      expect(result.reason).toBe('short_description');
    });
  });

  describe('askIfBugMissingExpectedBehavior', () => {
    beforeEach(() => {
      process.env.REFINEMENT_INTERACTIVE_QUESTIONS_ENABLED = 'true';
      process.env.REFINEMENT_QUESTION_TIMEOUT_MS = '50';
    });

    it('skips when type is not bug', async () => {
      const demand = makeDemand({ type: 'melhoria' });
      const result = await askIfBugMissingExpectedBehavior(demand);
      expect(result.asked).toBe(false);
      expect(result.reason).toBe('not_bug');
    });

    it('skips when description has expected and actual', async () => {
      const demand = makeDemand({
        type: 'bug',
        description:
          'O comportamento esperado era X, mas o atual é Y. Deveria mostrar A, mas aconteceu B.',
      });
      const result = await askIfBugMissingExpectedBehavior(demand);
      expect(result.asked).toBe(false);
      expect(result.reason).toBe('expected_and_actual_present');
    });

    it('asks when bug lacks expected/actual (timeout)', async () => {
      const demand = makeDemand({
        id: 200,
        type: 'bug',
        description: 'Sistema quebrou na tela de login',
      });
      const result = await askIfBugMissingExpectedBehavior(demand);
      expect(result.asked).toBe(false);
      expect(result.reason).toBe('timeout');
    });
  });

  describe('askIfCriticalWithoutDeadline', () => {
    beforeEach(() => {
      process.env.REFINEMENT_INTERACTIVE_QUESTIONS_ENABLED = 'true';
      process.env.REFINEMENT_QUESTION_TIMEOUT_MS = '50';
    });

    it('skips when priority is not critica', async () => {
      const demand = makeDemand({ priority: 'media' });
      const result = await askIfCriticalWithoutDeadline(demand);
      expect(result.asked).toBe(false);
      expect(result.reason).toBe('not_critical');
    });

    it('skips when description mentions deadline', async () => {
      const demand = makeDemand({
        priority: 'critica',
        description: 'Precisa entregar até sexta-feira, é urgente.',
      });
      const result = await askIfCriticalWithoutDeadline(demand);
      expect(result.asked).toBe(false);
      expect(result.reason).toBe('deadline_mentioned');
    });

    it('asks when critical lacks deadline (timeout)', async () => {
      const demand = makeDemand({
        id: 300,
        priority: 'critica',
        description: 'Precisamos arrumar isso logo.',
      });
      const result = await askIfCriticalWithoutDeadline(demand);
      expect(result.asked).toBe(false);
      expect(result.reason).toBe('timeout');
    });
  });

  describe('runClarificationHooks', () => {
    beforeEach(() => {
      process.env.REFINEMENT_INTERACTIVE_QUESTIONS_ENABLED = 'true';
      process.env.REFINEMENT_QUESTION_TIMEOUT_MS = '50';
    });

    it('runs all 3 hooks in sequence', async () => {
      const demand = makeDemand({
        id: 400,
        type: 'nova_funcionalidade',
        description: 'curta',
        priority: 'critica',
      });
      const results = await runClarificationHooks(demand);
      expect(results).toHaveLength(3);
      // All will timeout (no PO to answer)
      expect(results.every((r) => !r.asked)).toBe(true);
    });

    it('skips inapplicable hooks for non-bug, non-critical, long-desc', async () => {
      const longDesc = Array(40).fill('palavra').join(' ');
      const demand = makeDemand({
        id: 401,
        type: 'melhoria',
        description: longDesc,
        priority: 'media',
      });
      const results = await runClarificationHooks(demand);
      expect(results.map((r) => r.reason)).toEqual(['not_new_feature', 'not_bug', 'not_critical']);
    });
  });
});
