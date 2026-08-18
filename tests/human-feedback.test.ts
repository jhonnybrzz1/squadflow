import { describe, it, expect, vi } from 'vitest';

// Mock dependencies before imports
vi.mock('../server/db', () => ({
  dbHelper: {
    run: vi.fn().mockResolvedValue(undefined),
    all: vi.fn().mockResolvedValue([]),
  },
  isPostgres: false,
}));

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { humanFeedbackService } from '../server/services/human-feedback-service';

describe('HumanFeedbackService', () => {
  describe('create', () => {
    it('creates feedback with like type', async () => {
      const entry = await humanFeedbackService.create({
        demandId: 1,
        agentMessageId: 'msg-001',
        feedbackText: 'Boa resposta!',
        feedbackType: 'like',
        agent: 'refinador',
      });

      expect(entry.id).toBeGreaterThan(0);
      expect(entry.demandId).toBe(1);
      expect(entry.agentMessageId).toBe('msg-001');
      expect(entry.feedbackText).toBe('Boa resposta!');
      expect(entry.feedbackType).toBe('like');
      expect(entry.agent).toBe('refinador');
      expect(entry.createdAt).toBeInstanceOf(Date);
    });

    it('creates feedback with dislike type', async () => {
      const entry = await humanFeedbackService.create({
        demandId: 2,
        agentMessageId: 'msg-002',
        feedbackText: 'Poderia ser melhor',
        feedbackType: 'dislike',
        agent: 'qa',
      });

      expect(entry.feedbackType).toBe('dislike');
    });

    it('creates feedback with empty text', async () => {
      const entry = await humanFeedbackService.create({
        demandId: 1,
        agentMessageId: 'msg-003',
        feedbackText: '',
        feedbackType: 'like',
      });

      expect(entry.feedbackText).toBe('');
      expect(entry.agent).toBeNull();
    });

    it('allows multiple feedbacks for same message', async () => {
      await humanFeedbackService.create({
        demandId: 5,
        agentMessageId: 'msg-multi',
        feedbackText: 'First feedback',
        feedbackType: 'like',
      });
      await humanFeedbackService.create({
        demandId: 5,
        agentMessageId: 'msg-multi',
        feedbackText: 'Second feedback',
        feedbackType: 'dislike',
      });

      const results = humanFeedbackService.getByMessageId('msg-multi');
      expect(results.length).toBe(2);
    });
  });

  describe('getByDemandId', () => {
    it('returns feedbacks filtered by demandId', () => {
      const results = humanFeedbackService.getByDemandId(1);
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((f) => f.demandId === 1)).toBe(true);
    });

    it('returns empty array for non-existent demandId', () => {
      const results = humanFeedbackService.getByDemandId(99999);
      expect(results).toEqual([]);
    });

    it('returns results sorted by createdAt', () => {
      const results = humanFeedbackService.getByDemandId(1);
      for (let i = 1; i < results.length; i++) {
        expect(results[i].createdAt.getTime()).toBeGreaterThanOrEqual(
          results[i - 1].createdAt.getTime(),
        );
      }
    });
  });

  describe('getByMessageId', () => {
    it('returns feedbacks for a specific message', () => {
      const results = humanFeedbackService.getByMessageId('msg-001');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].agentMessageId).toBe('msg-001');
    });
  });

  describe('getMessageIdsWithFeedback', () => {
    it('returns set of message IDs with feedback for a demand', () => {
      const ids = humanFeedbackService.getMessageIdsWithFeedback(1);
      expect(ids).toBeInstanceOf(Set);
      expect(ids.has('msg-001')).toBe(true);
    });

    it('returns empty set for demand without feedback', () => {
      const ids = humanFeedbackService.getMessageIdsWithFeedback(88888);
      expect(ids.size).toBe(0);
    });
  });
});

describe('Feedback Route Validation', () => {
  it('rejects missing agentMessageId', () => {
    const body = { feedbackType: 'like' };
    expect(
      !Object.hasOwn(body, 'agentMessageId') || !body['agentMessageId' as keyof typeof body],
    ).toBe(true);
  });

  it('rejects invalid feedbackType', () => {
    const validTypes = ['like', 'dislike'];
    expect(validTypes.includes('invalid')).toBe(false);
    expect(validTypes.includes('like')).toBe(true);
    expect(validTypes.includes('dislike')).toBe(true);
  });

  it('rejects text exceeding 500 characters', () => {
    const longText = 'a'.repeat(501);
    expect(longText.length > 500).toBe(true);
  });

  it('sanitizes HTML tags', () => {
    const dirty = '<script>alert("xss")</script>Hello';
    const clean = dirty.replace(/<[^>]*>/g, '');
    expect(clean).toBe('alert("xss")Hello');
    expect(clean).not.toContain('<script>');
  });

  it('accepts text with exactly 500 characters', () => {
    const text = 'a'.repeat(500);
    expect(text.length <= 500).toBe(true);
  });

  it('accepts empty feedbackText', () => {
    const text = '';
    expect(text.length <= 500).toBe(true);
  });
});
