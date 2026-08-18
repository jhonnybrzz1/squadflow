import { describe, expect, it, vi } from 'vitest';
import { GitHubReposCache } from '../server/services/github-repos-cache';

describe('GitHubReposCache', () => {
  it('returns cached values before TTL expires', () => {
    vi.useFakeTimers();
    const cache = new GitHubReposCache<string[]>();

    cache.set(['repo-a']);

    expect(cache.get()).toEqual(['repo-a']);
    expect(cache.getStats().hit).toBe(true);

    vi.useRealTimers();
  });

  it('expires values after five minutes', () => {
    vi.useFakeTimers();
    const cache = new GitHubReposCache<string[]>();

    cache.set(['repo-a']);
    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(cache.get()).toBeNull();
    expect(cache.getStats().hit).toBe(false);

    vi.useRealTimers();
  });
});
