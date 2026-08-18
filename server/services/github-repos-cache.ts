const GITHUB_REPOS_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class GitHubReposCache<T> {
  private entry: CacheEntry<T> | null = null;

  get(): T | null {
    if (!this.entry) return null;
    if (Date.now() >= this.entry.expiresAt) {
      this.entry = null;
      return null;
    }
    return this.entry.value;
  }

  set(value: T): void {
    this.entry = {
      value,
      expiresAt: Date.now() + GITHUB_REPOS_CACHE_TTL_MS,
    };
  }

  clear(): void {
    this.entry = null;
  }

  getStats(): { hit: boolean; ttlMs: number; expiresAt: string | null } {
    const now = Date.now();
    const ttlMs = this.entry ? Math.max(0, this.entry.expiresAt - now) : 0;

    return {
      hit: Boolean(this.entry && ttlMs > 0),
      ttlMs,
      expiresAt: this.entry ? new Date(this.entry.expiresAt).toISOString() : null,
    };
  }
}

export const githubReposCache = new GitHubReposCache<unknown[]>();
