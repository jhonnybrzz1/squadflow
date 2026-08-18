import { describe, expect, it, vi } from 'vitest';
import { GitHubService } from '../../server/services/github';

describe('GitHubService cancellation propagation', () => {
  it('passes the caller AbortSignal to repos.getContent', async () => {
    const service = new GitHubService('ghp_test_token');
    const controller = new AbortController();
    controller.abort();
    const getContent = vi.fn().mockResolvedValue({ data: { type: 'file' } });
    service.client.repos.getContent = getContent as typeof service.client.repos.getContent;

    await service.getRepoContent('owner', 'repo', 'src/index.ts', controller.signal);

    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({ request: { signal: controller.signal } }),
    );
    expect(controller.signal.aborted).toBe(true);
  });

  it('passes the caller AbortSignal to search.code', async () => {
    const service = new GitHubService('ghp_test_token');
    const controller = new AbortController();
    controller.abort();
    const searchCode = vi.fn().mockResolvedValue({ data: { total_count: 0, items: [] } });
    service.client.search.code = searchCode as typeof service.client.search.code;

    await service.searchRepo('owner', 'repo', 'authenticate', controller.signal);

    expect(searchCode).toHaveBeenCalledWith(
      expect.objectContaining({ request: { signal: controller.signal } }),
    );
    expect(controller.signal.aborted).toBe(true);
  });
});

describe('GitHubService robust content helpers', () => {
  it('resolves the default branch SHA before requesting the recursive tree', async () => {
    const service = new GitHubService('ghp_test_token');
    service.client.repos.get = vi.fn().mockResolvedValue({
      data: { default_branch: 'trunk' },
      headers: {},
    }) as typeof service.client.repos.get;
    service.client.git.getRef = vi.fn().mockResolvedValue({
      data: { object: { sha: 'resolved-sha' } },
      headers: {},
    }) as typeof service.client.git.getRef;
    const getTree = vi.fn().mockResolvedValue({
      data: { truncated: false, tree: [{ type: 'blob', path: 'src/index.ts' }] },
      headers: { 'x-ratelimit-remaining': '41', 'x-ratelimit-reset': '1700000000' },
    });
    service.client.git.getTree = getTree as typeof service.client.git.getTree;

    const result = await service.getRepoTreePaths('owner', 'repo');

    expect(getTree).toHaveBeenCalledWith(
      expect.objectContaining({ tree_sha: 'resolved-sha', recursive: 'true' }),
    );
    expect(result).toMatchObject({
      available: true,
      sha: 'resolved-sha',
      paths: ['src/index.ts'],
      rateLimit: { remaining: 41 },
    });
  });

  it('paginates code search within the configured result budget', async () => {
    const service = new GitHubService('ghp_test_token');
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ path: `src/${index}.ts` }));
    const searchCode = vi
      .fn()
      .mockResolvedValueOnce({
        data: { total_count: 101, items: firstPage },
        headers: { 'x-ratelimit-remaining': '40' },
      })
      .mockResolvedValueOnce({
        data: { total_count: 101, items: [{ path: 'src/final.ts' }] },
        headers: { 'x-ratelimit-remaining': '39', 'x-ratelimit-reset': '1700000000' },
      });
    service.client.search.code = searchCode as typeof service.client.search.code;

    const result = await service.searchRepoWithMetadata('owner', 'repo', 'authenticate');

    expect(searchCode).toHaveBeenCalledTimes(2);
    expect(searchCode).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ page: 2, per_page: 100 }),
    );
    expect(result.data).toHaveLength(101);
    expect(result.rateLimit.remaining).toBe(39);
  });

  it('uses binary-content inspection and reports the path as omitted', async () => {
    const service = new GitHubService('ghp_test_token');
    vi.spyOn(service, 'getDefaultBranchSha').mockResolvedValue('resolved-sha');
    vi.spyOn(service, 'getRepoContentWithMetadata').mockResolvedValue({
      data: { path: 'assets/logo.png', size: 4, encoding: 'base64' } as never,
      rateLimit: { remaining: 38, resetAt: null },
    });
    const getBinaryContent = vi
      .spyOn(service, 'getBinaryContent')
      .mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await service.getSafeTextContent('owner', 'repo', 'assets/logo.png');

    expect(getBinaryContent).toHaveBeenCalledWith(
      'owner',
      'repo',
      'assets/logo.png',
      'resolved-sha',
      undefined,
    );
    expect(result).toMatchObject({
      status: 'omitted',
      path: 'assets/logo.png',
      reason: 'binary',
      sha: 'resolved-sha',
    });
    expect(result).not.toHaveProperty('content');
  });

  it('rejects oversized files before downloading their bytes', async () => {
    const service = new GitHubService('ghp_test_token');
    vi.spyOn(service, 'getDefaultBranchSha').mockResolvedValue('resolved-sha');
    vi.spyOn(service, 'getRepoContentWithMetadata').mockResolvedValue({
      data: { path: 'data/huge.json', size: 300_000, encoding: 'base64' } as never,
      rateLimit: { remaining: 37, resetAt: null },
    });
    const getBinaryContent = vi.spyOn(service, 'getBinaryContent');

    const result = await service.getSafeTextContent('owner', 'repo', 'data/huge.json');

    expect(result).toMatchObject({ status: 'omitted', reason: 'oversized', size: 300_000 });
    expect(getBinaryContent).not.toHaveBeenCalled();
  });
});
