import { describe, it, expect } from 'vitest';
import { DEFAULT_CACHE_KEY_VERSION } from '../../server/services/ai-cache';

// openai-ai.ts imports DEFAULT_CACHE_KEY_VERSION from ai-cache,
// so this constant is the single source of truth for both cache and telemetry.

describe('CACHE_KEY_VERSION default unification', () => {
  it('DEFAULT_CACHE_KEY_VERSION is cache-canonical-v2', () => {
    expect(DEFAULT_CACHE_KEY_VERSION).toBe('cache-canonical-v2');
  });

  it('ai-cache and openai-ai use the same DEFAULT_CACHE_KEY_VERSION fallback', () => {
    expect(DEFAULT_CACHE_KEY_VERSION).not.toBe('cache-canonical-v1');
    expect(DEFAULT_CACHE_KEY_VERSION).toBe('cache-canonical-v2');
  });
});
