import { describe, it, expect } from 'vitest';
import {
  prepareMessages,
  trimConversationHistory,
  estimateMessagesTokens,
  canonicalizeMessages,
  canonicalizeCacheValue,
  canonicalizeText,
  isInstructionRole,
} from '../server/services/llm-message-preparer';
import type { AIChatMessage } from '../server/services/openai-ai';

describe('llm-message-preparer', () => {
  describe('prepareMessages', () => {
    it('normalizes and filters empty messages', () => {
      const messages: AIChatMessage[] = [
        { role: 'user', content: '  Hello  ' },
        { role: 'assistant', content: '   ' },
        { role: 'user', content: 'World' },
      ];
      const result = prepareMessages(messages, {});
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('Hello');
      expect(result[1].content).toBe('World');
    });

    it('throws error if no messages after filtering', () => {
      const messages: AIChatMessage[] = [{ role: 'user', content: '   ' }];
      expect(() => prepareMessages(messages, {})).toThrow('At least one chat message is required.');
    });

    it('separates instruction messages from conversation', () => {
      const messages: AIChatMessage[] = [
        { role: 'system', content: 'You are helpful' },
        { role: 'developer', content: 'Be concise' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ];
      const result = prepareMessages(messages, {});
      expect(result).toHaveLength(4);
      expect(result[0].role).toBe('system');
      expect(result[1].role).toBe('developer');
    });

    it('includes summary memory when provided', () => {
      const messages: AIChatMessage[] = [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hello' },
      ];
      const result = prepareMessages(messages, { summaryMemory: 'Previous context' });
      expect(result).toHaveLength(3);
      expect(result[1].content).toContain('Resumo persistente da conversa');
    });
  });

  describe('trimConversationHistory', () => {
    it('keeps all messages when under limit', () => {
      const messages: AIChatMessage[] = [
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'B' },
      ];
      const result = trimConversationHistory(messages, 5);
      expect(result).toHaveLength(2);
    });

    it('trims to max history turns (user turns)', () => {
      const messages: AIChatMessage[] = [
        { role: 'user', content: 'A1' },
        { role: 'assistant', content: 'B1' },
        { role: 'user', content: 'A2' },
        { role: 'assistant', content: 'B2' },
        { role: 'user', content: 'A3' },
        { role: 'assistant', content: 'B3' },
      ];
      const result = trimConversationHistory(messages, 2);
      expect(result.length).toBeGreaterThan(0);
      expect(result[result.length - 1].content).toBe('B3');
    });

    it('returns all messages when maxHistoryTurns is 0', () => {
      const messages: AIChatMessage[] = [
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'B' },
      ];
      const result = trimConversationHistory(messages, 0);
      expect(result).toHaveLength(2);
    });
  });

  describe('estimateMessagesTokens', () => {
    it('estimates tokens based on character count', () => {
      const messages: AIChatMessage[] = [
        { role: 'user', content: 'Hello world' }, // 11 chars ~ 3 tokens
        { role: 'assistant', content: 'Hi there' }, // 8 chars ~ 2 tokens
      ];
      const result = estimateMessagesTokens(messages);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(10);
    });
  });

  describe('canonicalizeMessages', () => {
    it('canonicalizes message content (redacts request IDs, preserves timestamps)', () => {
      // H-13: timestamps are now preserved; only request IDs are redacted
      const messages: AIChatMessage[] = [
        { role: 'user', content: 'requestId=abc123 at 2026-05-05T12:00:00Z' },
      ];
      const result = canonicalizeMessages(messages);
      expect(result[0].content).toContain('<id>');
      expect(result[0].content).toContain('2026-05-05T12:00:00Z');
      expect(result[0].content).not.toContain('<datetime>');
    });
  });

  describe('canonicalizeCacheValue', () => {
    it('canonicalizes string values', () => {
      const result = canonicalizeCacheValue('sk-abc123def4567890123456');
      expect(result).toBe('<api-key>');
    });

    it('canonicalizes arrays recursively', () => {
      const result = canonicalizeCacheValue([
        'sk-abc123def4567890123456',
        'sk-def4567890123456789012',
      ]);
      expect(result).toEqual(['<api-key>', '<api-key>']);
    });

    it('canonicalizes objects recursively', () => {
      // H-13: UUIDs are now preserved, not replaced
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const result = canonicalizeCacheValue({
        key: 'sk-abc123def4567890123456', // gitleaks:allow -- synthetic redaction fixture
        nested: { value: uuid },
      });
      expect(result).toEqual({ key: '<api-key>', nested: { value: uuid } });
    });
  });

  describe('canonicalizeText', () => {
    // H-13: UUIDs, timestamps, and hashes are now PRESERVED (not replaced)
    // because they are meaningful distinctions in prompt content. Replacing
    // them caused cache collisions between different demands.

    it('H-13: preserves UUIDs (does not replace with <uuid>)', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const result = canonicalizeText(`id: ${uuid}`);
      expect(result).toContain(uuid);
      expect(result).not.toContain('<uuid>');
    });

    it('H-13: preserves ISO timestamps (does not replace with <datetime>)', () => {
      const ts = '2026-05-05T12:00:00Z';
      const result = canonicalizeText(`at ${ts}`);
      expect(result).toContain(ts);
      expect(result).not.toContain('<datetime>');
    });

    it('H-13: preserves epoch timestamps (does not replace with <timestamp>)', () => {
      const result = canonicalizeText('epoch: 1714900800');
      expect(result).toContain('1714900800');
      expect(result).not.toContain('<timestamp>');
    });

    it('replaces API keys (security redaction stays)', () => {
      const result = canonicalizeText('key: sk-abc123def4567890123456'); // gitleaks:allow -- synthetic redaction fixture
      expect(result).toContain('<api-key>');
      expect(result).not.toContain('sk-abc123def4567890123456');
    });

    it('replaces request IDs', () => {
      const result = canonicalizeText('requestId=abc123');
      expect(result).toContain('requestId=<id>');
    });
  });

  describe('isInstructionRole', () => {
    it('returns true for system role', () => {
      expect(isInstructionRole('system')).toBe(true);
    });

    it('returns true for developer role', () => {
      expect(isInstructionRole('developer')).toBe(true);
    });

    it('returns false for user role', () => {
      expect(isInstructionRole('user')).toBe(false);
    });

    it('returns false for assistant role', () => {
      expect(isInstructionRole('assistant')).toBe(false);
    });
  });
});
