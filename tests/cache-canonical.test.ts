/**
 * Tests for Canonical Cache
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { aiResponseCache } from '../server/services/ai-cache';

describe('Canonical Cache', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...originalEnv };
    delete process.env.CACHE_KEY_VERSION;
    aiResponseCache.clear();
  });

  afterEach(() => {
    // Restore environment after each test
    process.env = originalEnv;
    aiResponseCache.clear();
  });

  describe('cache key generation', () => {
    it('should generate same key for identical prompts', () => {
      const payload1 = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello world' }],
        temperature: 0.7,
      };
      const payload2 = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello world' }],
        temperature: 0.7,
      };

      const key1 = aiResponseCache.createKey(payload1);
      const key2 = aiResponseCache.createKey(payload2);

      expect(key1).toBe(key2);
    });

    it('should generate different keys for different prompts', () => {
      const payload1 = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello world' }],
        temperature: 0.7,
      };
      const payload2 = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Goodbye world' }],
        temperature: 0.7,
      };

      const key1 = aiResponseCache.createKey(payload1);
      const key2 = aiResponseCache.createKey(payload2);

      expect(key1).not.toBe(key2);
    });

    it('should generate different keys for different models', () => {
      const payload = {
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
      };

      const key1 = aiResponseCache.createKey({ ...payload, model: 'gpt-4o-mini' });
      const key2 = aiResponseCache.createKey({ ...payload, model: 'gpt-4o' });

      expect(key1).not.toBe(key2);
    });

    it('should generate different keys for different temperatures', () => {
      const payload = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const key1 = aiResponseCache.createKey({ ...payload, temperature: 0.7 });
      const key2 = aiResponseCache.createKey({ ...payload, temperature: 0.9 });

      expect(key1).not.toBe(key2);
    });

    it('should include cache key version in hash', () => {
      process.env.CACHE_KEY_VERSION = 'v1';
      const payload = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
      };

      const key1 = aiResponseCache.createKey(payload);

      process.env.CACHE_KEY_VERSION = 'v2';
      const key2 = aiResponseCache.createKey(payload);

      expect(key1).not.toBe(key2);
    });

    it('CRIT-8: omitir uma chave e setá-la como undefined devem gerar a MESMA cache key', () => {
      const withUndefined = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        maxTokens: undefined,
      };
      const withoutKey = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
      };

      const key1 = aiResponseCache.createKey(withUndefined);
      const key2 = aiResponseCache.createKey(withoutKey);

      expect(key1).toBe(key2);
    });

    it('should generate different keys for prompts with extra whitespace', () => {
      const payload1 = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello world' }],
        temperature: 0.7,
      };
      const payload2 = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello  world' }], // extra space
        temperature: 0.7,
      };

      const key1 = aiResponseCache.createKey(payload1);
      const key2 = aiResponseCache.createKey(payload2);

      expect(key1).not.toBe(key2);
    });

    it('H-12: should generate different keys for different agentName', () => {
      const base = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
      };
      const key1 = aiResponseCache.createKey({ ...base, agentName: 'pm_agent' });
      const key2 = aiResponseCache.createKey({ ...base, agentName: 'tech_agent' });
      expect(key1).not.toBe(key2);
    });

    it('H-12: should generate different keys for different demandId', () => {
      const base = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        agentName: 'pm_agent',
      };
      const key1 = aiResponseCache.createKey({ ...base, demandId: 100 });
      const key2 = aiResponseCache.createKey({ ...base, demandId: 200 });
      expect(key1).not.toBe(key2);
    });

    it('H-12: should generate same key for same agentName and demandId', () => {
      const base = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        agentName: 'pm_agent',
        demandId: 100,
      };
      const key1 = aiResponseCache.createKey(base);
      const key2 = aiResponseCache.createKey({ ...base });
      expect(key1).toBe(key2);
    });
  });

  describe('cache operations', () => {
    it('should store and retrieve cached values', () => {
      const key = 'test-key';
      const value = 'cached response';

      aiResponseCache.set(key, value);
      const retrieved = aiResponseCache.get(key);

      expect(retrieved).toBe(value);
    });

    it('should return null for non-existent keys', () => {
      const retrieved = aiResponseCache.get('non-existent-key');
      expect(retrieved).toBeNull();
    });

    it('should handle cache hits correctly', () => {
      const key = 'test-key';
      const value = 'cached response';

      aiResponseCache.set(key, value);
      const retrieved = aiResponseCache.get(key);

      expect(retrieved).toBe(value);
      // Note: stats accumulate across tests, so we don't check exact values here
    });

    it('should handle cache misses correctly', () => {
      const retrieved = aiResponseCache.get('non-existent-key');
      expect(retrieved).toBeNull();
      // Note: stats accumulate across tests, so we don't check exact values here
    });

    it('should calculate hit rate correctly', () => {
      aiResponseCache.clear(); // Start with clean cache

      const key = 'test-key';
      const value = 'cached response';

      // 1 hit
      aiResponseCache.set(key, value);
      aiResponseCache.get(key);

      // 2 misses
      aiResponseCache.get('miss-1');
      aiResponseCache.get('miss-2');

      const stats = aiResponseCache.getStats();
      expect(stats.hitRate).toBeCloseTo(1 / 3, 2);
    });

    it('should respect TTL and expire entries', async () => {
      const key = 'test-key';
      const value = 'cached response';

      // Set with very short TTL (1ms)
      aiResponseCache.set(key, value, 1);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 10));

      const retrieved = aiResponseCache.get(key);
      expect(retrieved).toBeNull();
    });

    it('should clear cache correctly', () => {
      const key1 = 'key1';
      const key2 = 'key2';

      aiResponseCache.set(key1, 'value1');
      aiResponseCache.set(key2, 'value2');

      aiResponseCache.clear();

      expect(aiResponseCache.get(key1)).toBeNull();
      expect(aiResponseCache.get(key2)).toBeNull();
    });
  });

  describe('cache version invalidation', () => {
    it('should invalidate cache when version changes', () => {
      process.env.CACHE_KEY_VERSION = 'v1';
      const payload = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
      };

      const key1 = aiResponseCache.createKey(payload);
      aiResponseCache.set(key1, 'response-v1');

      // Change version
      process.env.CACHE_KEY_VERSION = 'v2';
      const key2 = aiResponseCache.createKey(payload);

      expect(key1).not.toBe(key2);
      // Old key still has the value (cache doesn't auto-clean on version change)
      expect(aiResponseCache.get(key1)).toBe('response-v1');
      // New key doesn't exist yet
      expect(aiResponseCache.get(key2)).toBeNull();
    });
  });

  describe('cache statistics', () => {
    it('should return correct statistics', () => {
      aiResponseCache.clear(); // Start with clean cache

      const key = 'test-key';
      const value = 'cached response';

      // Set and get (hit)
      aiResponseCache.set(key, value);
      aiResponseCache.get(key);

      // Get non-existent (miss)
      aiResponseCache.get('non-existent');

      const stats = aiResponseCache.getStats();
      expect(stats.enabled).toBe(true);
      expect(stats.size).toBe(1);
      expect(stats.totalHits).toBe(1);
      expect(stats.totalMisses).toBe(1);
      expect(stats.hitRate).toBe(0.5);
    });

    it('should handle empty cache correctly', () => {
      aiResponseCache.clear(); // Start with clean cache

      const stats = aiResponseCache.getStats();
      expect(stats.size).toBe(0);
      expect(stats.totalHits).toBe(0);
      expect(stats.totalMisses).toBe(0);
      expect(stats.hitRate).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty values correctly', () => {
      const key = 'test-key';
      const emptyValue = '';

      aiResponseCache.set(key, emptyValue);
      const retrieved = aiResponseCache.get(key);

      // Empty values should not be cached
      expect(retrieved).toBeNull();
    });

    it('should handle whitespace-only values correctly', () => {
      const key = 'test-key';
      const whitespaceValue = '   ';

      aiResponseCache.set(key, whitespaceValue);
      const retrieved = aiResponseCache.get(key);

      // Whitespace-only values should not be cached
      expect(retrieved).toBeNull();
    });

    it('should handle very long values correctly', () => {
      const key = 'test-key';
      const longValue = 'a'.repeat(10000);

      aiResponseCache.set(key, longValue);
      const retrieved = aiResponseCache.get(key);

      expect(retrieved).toBe(longValue);
    });

    it('should handle special characters in values correctly', () => {
      const key = 'test-key';
      const specialValue = 'Hello 🌍 World! @#$%^&*()';

      aiResponseCache.set(key, specialValue);
      const retrieved = aiResponseCache.get(key);

      expect(retrieved).toBe(specialValue);
    });
  });
});
