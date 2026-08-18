/**
 * Unit tests for server/services/tech-lead-tools.ts
 *
 * Strategy:
 * - vi.resetModules() + dynamic re-import in each describe block so the
 *   module-level TOOLS_REGISTRY Map starts fresh and tools can be re-registered
 *   without "already registered" conflicts.
 * - repoService mock is hoisted once; individual tests control resolved values.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks before any import
// ---------------------------------------------------------------------------

vi.mock('../../server/services/repo-service', () => ({
  repoService: {
    getRepoWithFiles: vi.fn(),
    getOrCreateRepo: vi.fn(),
  },
}));

// TOOL-001/GH-002: mock GitHub service so the live-API fallback path is
// deterministic in tests. Default to unavailable (no token).
vi.mock('../../server/services/github', () => ({
  gitHubService: {
    isAvailable: vi.fn().mockReturnValue(false),
    getRepoTreePaths: vi.fn().mockResolvedValue({ available: false, truncated: false, paths: [] }),
    searchRepo: vi.fn().mockResolvedValue([]),
    searchRepoWithMetadata: vi.fn().mockResolvedValue({
      data: [],
      rateLimit: { remaining: null, resetAt: null },
    }),
    getRepoContent: vi.fn().mockRejectedValue(new Error('GitHub token not set')),
    getSafeTextContent: vi.fn().mockRejectedValue(new Error('GitHub token not set')),
  },
}));

// Mock metrics to avoid duplicate-registration errors when vi.resetModules
// re-imports the metrics module in each describe block.
vi.mock('../../server/metrics', () => ({
  githubToolFallbackTotal: { labels: vi.fn().mockReturnValue({ inc: vi.fn() }) },
  githubToolFailureTotal: { labels: vi.fn().mockReturnValue({ inc: vi.fn() }) },
}));

// Mock logger to suppress noise
vi.mock('../../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lazily import registry + tools after vi.resetModules() */
async function importFresh() {
  const registry = await import('../../server/services/agent-tools-registry');
  const { registerTechLeadTools } = await import('../../server/services/tech-lead-tools');
  const repoServiceModule = await import('../../server/services/repo-service');
  return { registry, registerTechLeadTools, repoServiceModule };
}

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

const mockFile = {
  path: 'src/services/auth.ts',
  filename: 'auth.ts',
  language: 'ts',
  content: 'export function authenticate(user: string) {\n  return true;\n}\n',
  size: 60,
};

const mockRepoRecord = {
  fullName: 'owner/repo',
  description: 'A test repo',
  language: 'TypeScript',
  size: 1024,
  stars: 10,
  defaultBranch: 'main',
  lastCommit: 'abc123',
  lastCommitDate: new Date().toISOString(),
  briefing: JSON.stringify({
    projectType: 'web',
    techStack: ['React', 'Node.js'],
    architecturalPattern: 'MVC',
    criticalAreas: ['auth', 'payments'],
    sensitiveAreas: ['user-data'],
  }),
  briefingGeneratedAt: new Date().toISOString(),
  systemMap: '[CRÍTICO] src/payments\n[SENSÍVEL] src/user-data',
};

// ==========================================================================
// Tool 1: search_codebase
// ==========================================================================

describe('search_codebase', () => {
  let registry: Awaited<ReturnType<typeof importFresh>>['registry'];
  let repoServiceModule: Awaited<ReturnType<typeof importFresh>>['repoServiceModule'];

  beforeEach(async () => {
    vi.resetModules();
    const imports = await importFresh();
    registry = imports.registry;
    repoServiceModule = imports.repoServiceModule;
    imports.registerTechLeadTools();
  });

  it('returns matching files when pattern is found in file content', async () => {
    vi.mocked(repoServiceModule.repoService.getRepoWithFiles).mockResolvedValue({
      files: [mockFile],
    } as any);

    const result = await registry.executeTool('search_codebase', {
      repoFullName: 'owner/repo',
      pattern: 'authenticate',
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('search_codebase');
    const data = result.data as any;
    expect(data.pattern).toBe('authenticate');
    expect(data.matchingFiles).toBe(1);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].path).toBe('src/services/auth.ts');
    expect(data.results[0].matches.length).toBeGreaterThan(0);
  });

  it('returns matchingFiles: 0 when pattern is not found in any file', async () => {
    vi.mocked(repoServiceModule.repoService.getRepoWithFiles).mockResolvedValue({
      files: [mockFile],
    } as any);

    const result = await registry.executeTool('search_codebase', {
      repoFullName: 'owner/repo',
      pattern: 'nonExistentSymbol_xyz',
    });

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.matchingFiles).toBe(0);
    expect(data.results).toHaveLength(0);
  });

  it('filters by language when language param is provided', async () => {
    // pyFile has different content — does NOT contain 'authenticate'
    const pyFile = {
      path: 'src/util.py',
      filename: 'util.py',
      language: 'py',
      content: 'def helper():\n    return True\n',
      size: 30,
    };
    vi.mocked(repoServiceModule.repoService.getRepoWithFiles).mockResolvedValue({
      files: [mockFile, pyFile],
    } as any);

    const result = await registry.executeTool('search_codebase', {
      repoFullName: 'owner/repo',
      pattern: 'authenticate',
      language: 'py',
    });

    expect(result.ok).toBe(true);
    const data = result.data as any;
    // 'authenticate' is only in the .ts file, not in pyFile — no match when filtering by 'py'
    expect(data.matchingFiles).toBe(0);
  });

  it('returns ok:false when repo is not found and GitHub is unavailable', async () => {
    vi.mocked(repoServiceModule.repoService.getRepoWithFiles).mockResolvedValue(null);
    // GitHub fallback also unavailable (default mock returns available:false)

    const result = await registry.executeTool('search_codebase', {
      repoFullName: 'owner/repo',
      pattern: 'authenticate',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/não indexado|indisponível/i);
    expect(result.source).toBe('search_codebase');
  });

  it('passes its timeout AbortSignal to the GitHub live search', async () => {
    vi.mocked(repoServiceModule.repoService.getRepoWithFiles).mockResolvedValue(null);
    const githubModule = await import('../../server/services/github');
    vi.mocked(githubModule.gitHubService.isAvailable).mockReturnValue(true);
    vi.mocked(githubModule.gitHubService.searchRepoWithMetadata).mockResolvedValue({
      data: [],
      rateLimit: { remaining: 42, resetAt: null },
    });

    await registry.executeTool('search_codebase', {
      repoFullName: 'owner/repo',
      pattern: 'authenticate',
    });

    expect(githubModule.gitHubService.searchRepoWithMetadata).toHaveBeenCalledWith(
      'owner',
      'repo',
      'authenticate',
      expect.any(AbortSignal),
    );
    vi.mocked(githubModule.gitHubService.isAvailable).mockReturnValue(false);
  });

  it('returns ok:false when repoFullName has no slash', async () => {
    const result = await registry.executeTool('search_codebase', {
      repoFullName: 'invalid-repo-name',
      pattern: 'authenticate',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/inválido/i);
    expect(result.source).toBe('search_codebase');
  });

  it('respects maxResults limit', async () => {
    const manyFiles = Array.from({ length: 20 }, (_, i) => ({
      path: `src/file${i}.ts`,
      filename: `file${i}.ts`,
      language: 'ts',
      content: 'function doSomething() { return true; }',
      size: 40,
    }));

    vi.mocked(repoServiceModule.repoService.getRepoWithFiles).mockResolvedValue({
      files: manyFiles,
    } as any);

    const result = await registry.executeTool('search_codebase', {
      repoFullName: 'owner/repo',
      pattern: 'doSomething',
      maxResults: 3,
    });

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.results.length).toBeLessThanOrEqual(3);
  });
});

// ==========================================================================
// Tool 2: get_repo_briefing
// ==========================================================================

describe('get_repo_briefing', () => {
  let registry: Awaited<ReturnType<typeof importFresh>>['registry'];
  let repoServiceModule: Awaited<ReturnType<typeof importFresh>>['repoServiceModule'];

  beforeEach(async () => {
    vi.resetModules();
    const imports = await importFresh();
    registry = imports.registry;
    repoServiceModule = imports.repoServiceModule;
    imports.registerTechLeadTools();
  });

  it('returns repo data with parsed briefing on success', async () => {
    vi.mocked(repoServiceModule.repoService.getOrCreateRepo).mockResolvedValue(
      mockRepoRecord as any,
    );

    const result = await registry.executeTool('get_repo_briefing', {
      repoFullName: 'owner/repo',
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('get_repo_briefing');
    const data = result.data as any;
    expect(data.fullName).toBe('owner/repo');
    expect(data.language).toBe('TypeScript');
    expect(data.briefing).not.toBeNull();
    expect(data.briefing.techStack).toContain('React');
  });

  it('parses invalid JSON briefing as raw object', async () => {
    vi.mocked(repoServiceModule.repoService.getOrCreateRepo).mockResolvedValue({
      ...mockRepoRecord,
      briefing: 'not-valid-json',
    } as any);

    const result = await registry.executeTool('get_repo_briefing', {
      repoFullName: 'owner/repo',
    });

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.briefing).toEqual({ raw: 'not-valid-json' });
  });

  it('returns ok:false when repo is null', async () => {
    vi.mocked(repoServiceModule.repoService.getOrCreateRepo).mockResolvedValue(null as any);

    const result = await registry.executeTool('get_repo_briefing', {
      repoFullName: 'owner/repo',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/não encontrado/i);
    expect(result.source).toBe('get_repo_briefing');
  });

  it('returns ok:false when repoFullName has no slash', async () => {
    const result = await registry.executeTool('get_repo_briefing', {
      repoFullName: 'invalid',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/inválido/i);
  });
});

// ==========================================================================
// Tool 3: get_file_content
// ==========================================================================

describe('get_file_content', () => {
  let registry: Awaited<ReturnType<typeof importFresh>>['registry'];
  let repoServiceModule: Awaited<ReturnType<typeof importFresh>>['repoServiceModule'];

  beforeEach(async () => {
    vi.resetModules();
    const imports = await importFresh();
    registry = imports.registry;
    repoServiceModule = imports.repoServiceModule;
    imports.registerTechLeadTools();
  });

  it('returns file content when file is found', async () => {
    vi.mocked(repoServiceModule.repoService.getRepoWithFiles).mockResolvedValue({
      files: [mockFile],
    } as any);

    const result = await registry.executeTool('get_file_content', {
      repoFullName: 'owner/repo',
      filePath: 'src/services/auth.ts',
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('get_file_content');
    const data = result.data as any;
    expect(data.path).toBe('src/services/auth.ts');
    expect(data.content).toContain('authenticate');
    expect(data.truncated).toBe(false);
    expect(data.language).toBe('ts');
  });

  it('truncates content at 15000 chars and sets truncated:true', async () => {
    const longContent = 'x'.repeat(20000);
    vi.mocked(repoServiceModule.repoService.getRepoWithFiles).mockResolvedValue({
      files: [{ ...mockFile, content: longContent }],
    } as any);

    const result = await registry.executeTool('get_file_content', {
      repoFullName: 'owner/repo',
      filePath: 'src/services/auth.ts',
    });

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.content.length).toBe(15000);
    expect(data.truncated).toBe(true);
  });

  it('returns ok:false with suggestedFiles when file is not found', async () => {
    vi.mocked(repoServiceModule.repoService.getRepoWithFiles).mockResolvedValue({
      files: [mockFile],
    } as any);

    const result = await registry.executeTool('get_file_content', {
      repoFullName: 'owner/repo',
      filePath: 'src/services/nonexistent.ts',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/não encontrado/i);
    expect(result.source).toBe('get_file_content');
    const data = result.data as any;
    expect(Array.isArray(data.suggestedFiles)).toBe(true);
  });

  it('returns ok:false when repo is not found and GitHub is unavailable', async () => {
    vi.mocked(repoServiceModule.repoService.getRepoWithFiles).mockResolvedValue(null);

    const result = await registry.executeTool('get_file_content', {
      repoFullName: 'owner/repo',
      filePath: 'src/services/auth.ts',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/não indexado|indisponível/i);
  });

  it('returns ok:false when repoFullName has no slash', async () => {
    const result = await registry.executeTool('get_file_content', {
      repoFullName: 'invalid',
      filePath: 'src/auth.ts',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/inválido/i);
  });

  it('TOOL-001: falls back to GitHub live API when indexed table is empty', async () => {
    // Indexed table empty — GitHub tree returns paths, getContent returns base64.
    vi.mocked(repoServiceModule.repoService.getRepoWithFiles).mockResolvedValue(null);
    const githubModule = await import('../../server/services/github');
    vi.mocked(githubModule.gitHubService.isAvailable).mockReturnValue(true);
    vi.mocked(githubModule.gitHubService.getRepoTreePaths).mockResolvedValue({
      available: true,
      truncated: false,
      paths: ['src/auth.ts', 'README.md'],
    });
    vi.mocked(githubModule.gitHubService.getSafeTextContent).mockResolvedValue({
      status: 'content',
      path: 'src/auth.ts',
      content: 'export function authenticate() {}',
      size: 30,
      sha: 'abc123',
      rateLimit: { remaining: 42, resetAt: null },
    } as any);

    const result = await registry.executeTool('get_file_content', {
      repoFullName: 'owner/repo',
      filePath: 'src/auth.ts',
    });

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.source).toBe('github-live');
    expect(data.content).toContain('authenticate');
    expect(data.sha).toBe('abc123');
    expect(data.rateLimit.remaining).toBe(42);
    expect(githubModule.gitHubService.getSafeTextContent).toHaveBeenCalledWith(
      'owner',
      'repo',
      'src/auth.ts',
      expect.any(AbortSignal),
    );
    vi.mocked(githubModule.gitHubService.isAvailable).mockReturnValue(false);
  });

  it('reports binary GitHub content as an omitted file without injecting bytes', async () => {
    vi.mocked(repoServiceModule.repoService.getRepoWithFiles).mockResolvedValue(null);
    const githubModule = await import('../../server/services/github');
    vi.mocked(githubModule.gitHubService.isAvailable).mockReturnValue(true);
    vi.mocked(githubModule.gitHubService.getSafeTextContent).mockResolvedValue({
      status: 'omitted',
      path: 'assets/logo.png',
      reason: 'binary',
      size: 1024,
      sha: 'abc123',
      rateLimit: { remaining: 41, resetAt: null },
    });

    const result = await registry.executeTool('get_file_content', {
      repoFullName: 'owner/repo',
      filePath: 'assets/logo.png',
    });

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      omittedFiles: [{ path: 'assets/logo.png', reason: 'binary', size: 1024 }],
      sha: 'abc123',
      rateLimit: { remaining: 41 },
    });
    expect(result.data).not.toHaveProperty('content');
    vi.mocked(githubModule.gitHubService.isAvailable).mockReturnValue(false);
  });

  it('resolves file path with leading ./ prefix stripped', async () => {
    vi.mocked(repoServiceModule.repoService.getRepoWithFiles).mockResolvedValue({
      files: [mockFile],
    } as any);

    const result = await registry.executeTool('get_file_content', {
      repoFullName: 'owner/repo',
      filePath: './src/services/auth.ts',
    });

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.path).toBe('src/services/auth.ts');
  });
});

// ==========================================================================
// Tool 4: list_critical_areas
// ==========================================================================

describe('list_critical_areas', () => {
  let registry: Awaited<ReturnType<typeof importFresh>>['registry'];
  let repoServiceModule: Awaited<ReturnType<typeof importFresh>>['repoServiceModule'];

  beforeEach(async () => {
    vi.resetModules();
    const imports = await importFresh();
    registry = imports.registry;
    repoServiceModule = imports.repoServiceModule;
    imports.registerTechLeadTools();
  });

  it('returns criticalAreas and sensitiveAreas from briefing', async () => {
    vi.mocked(repoServiceModule.repoService.getOrCreateRepo).mockResolvedValue(
      mockRepoRecord as any,
    );

    const result = await registry.executeTool('list_critical_areas', {
      repoFullName: 'owner/repo',
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('list_critical_areas');
    const data = result.data as any;
    expect(data.criticalAreas).toContain('auth');
    expect(data.criticalAreas).toContain('payments');
    expect(data.sensitiveAreas).toContain('user-data');
  });

  it('extracts systemMapAreas from [CRÍTICO] and [SENSÍVEL] markers', async () => {
    vi.mocked(repoServiceModule.repoService.getOrCreateRepo).mockResolvedValue(
      mockRepoRecord as any,
    );

    const result = await registry.executeTool('list_critical_areas', {
      repoFullName: 'owner/repo',
    });

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.systemMapAreas.length).toBeGreaterThan(0);
    expect(data.systemMapAreas.some((a: string) => a.includes('payments'))).toBe(true);
  });

  it('returns empty arrays when briefing has no criticalAreas', async () => {
    vi.mocked(repoServiceModule.repoService.getOrCreateRepo).mockResolvedValue({
      ...mockRepoRecord,
      briefing: JSON.stringify({ techStack: ['React'] }),
      systemMap: null,
    } as any);

    const result = await registry.executeTool('list_critical_areas', {
      repoFullName: 'owner/repo',
    });

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.criticalAreas).toEqual([]);
    expect(data.sensitiveAreas).toEqual([]);
    expect(data.recommendation).toMatch(/nenhuma/i);
  });

  it('returns ok:false when repo is null', async () => {
    vi.mocked(repoServiceModule.repoService.getOrCreateRepo).mockResolvedValue(null as any);

    const result = await registry.executeTool('list_critical_areas', {
      repoFullName: 'owner/repo',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/não encontrado/i);
    expect(result.source).toBe('list_critical_areas');
  });

  it('returns ok:false when repoFullName has no slash', async () => {
    const result = await registry.executeTool('list_critical_areas', {
      repoFullName: 'badformat',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/inválido/i);
  });
});

// ==========================================================================
// Tool 5: get_tech_stack
// ==========================================================================

describe('get_tech_stack', () => {
  let registry: Awaited<ReturnType<typeof importFresh>>['registry'];
  let repoServiceModule: Awaited<ReturnType<typeof importFresh>>['repoServiceModule'];

  beforeEach(async () => {
    vi.resetModules();
    const imports = await importFresh();
    registry = imports.registry;
    repoServiceModule = imports.repoServiceModule;
    imports.registerTechLeadTools();
  });

  it('returns techStack and languageDistribution on success', async () => {
    vi.mocked(repoServiceModule.repoService.getRepoWithFiles).mockResolvedValue({
      repo: mockRepoRecord,
      files: [
        mockFile,
        { ...mockFile, path: 'src/index.ts', filename: 'index.ts' },
        { ...mockFile, path: 'src/util.js', filename: 'util.js', language: 'js' },
      ],
    } as any);

    const result = await registry.executeTool('get_tech_stack', {
      repoFullName: 'owner/repo',
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('get_tech_stack');
    const data = result.data as any;
    expect(data.techStack).toContain('React');
    expect(data.architecturalPattern).toBe('MVC');
    expect(data.projectType).toBe('web');
    expect(data.languageDistribution['ts']).toBe(2);
    expect(data.languageDistribution['js']).toBe(1);
    expect(data.primaryLanguage).toBe('TypeScript');
  });

  it('extracts dependencies from package.json when present', async () => {
    const packageJsonFile = {
      path: 'package.json',
      filename: 'package.json',
      language: 'json',
      content: JSON.stringify({
        dependencies: { react: '^18.0.0', express: '^4.0.0' },
        devDependencies: { vitest: '^1.0.0' },
      }),
      size: 100,
    };

    vi.mocked(repoServiceModule.repoService.getRepoWithFiles).mockResolvedValue({
      repo: mockRepoRecord,
      files: [mockFile, packageJsonFile],
    } as any);

    const result = await registry.executeTool('get_tech_stack', {
      repoFullName: 'owner/repo',
    });

    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.mainDependencies).toContain('react');
    expect(data.mainDependencies).toContain('express');
    expect(data.mainDependencies).toContain('vitest');
  });

  it('returns ok:false when repo is not found', async () => {
    vi.mocked(repoServiceModule.repoService.getRepoWithFiles).mockResolvedValue(null);

    const result = await registry.executeTool('get_tech_stack', {
      repoFullName: 'owner/repo',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/não encontrado/i);
    expect(result.source).toBe('get_tech_stack');
  });

  it('returns ok:false when repoFullName has no slash', async () => {
    const result = await registry.executeTool('get_tech_stack', {
      repoFullName: 'noslash',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/inválido/i);
  });

  it('handles invalid JSON in briefing gracefully', async () => {
    vi.mocked(repoServiceModule.repoService.getRepoWithFiles).mockResolvedValue({
      repo: { ...mockRepoRecord, briefing: 'not-json' },
      files: [mockFile],
    } as any);

    const result = await registry.executeTool('get_tech_stack', {
      repoFullName: 'owner/repo',
    });

    expect(result.ok).toBe(true);
    const data = result.data as any;
    // Falls back to defaults when briefing JSON parse fails
    expect(data.techStack).toEqual([]);
    expect(data.architecturalPattern).toBe('Desconhecido');
  });
});
