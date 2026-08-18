import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { OctokitGitHubOperations } from '../../server/services/github-write';
import { githubWriteTotal, githubWriteFailureTotal } from '../../server/metrics';

function createApiError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

async function successValue(operation: string): Promise<number> {
  const metric = await githubWriteTotal.get();
  return metric.values.find((v) => v.labels.operation === operation)?.value ?? 0;
}

async function failureValue(operation: string, reason: string): Promise<number> {
  const metric = await githubWriteFailureTotal.get();
  return (
    metric.values.find((v) => v.labels.operation === operation && v.labels.reason === reason)
      ?.value ?? 0
  );
}

describe('OctokitGitHubOperations guard', () => {
  const originalToken = process.env.GITHUB_WRITE_TOKEN;

  beforeEach(() => {
    githubWriteTotal.reset();
    githubWriteFailureTotal.reset();
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.GITHUB_WRITE_TOKEN;
    } else {
      process.env.GITHUB_WRITE_TOKEN = originalToken;
    }
  });

  it('rejects createOrUpdateFile without GITHUB_WRITE_TOKEN', async () => {
    delete process.env.GITHUB_WRITE_TOKEN;
    const ops = new OctokitGitHubOperations();
    await expect(
      ops.createOrUpdateFile('owner', 'repo', 'main', 'a.md', 'x', 'msg'),
    ).rejects.toThrow('GITHUB_WRITE_TOKEN');
  });

  it('rejects batchCreateFiles without GITHUB_WRITE_TOKEN', async () => {
    delete process.env.GITHUB_WRITE_TOKEN;
    const ops = new OctokitGitHubOperations();
    await expect(
      ops.batchCreateFiles('owner', 'repo', 'main', [{ path: 'a.md', content: 'x' }], 'msg'),
    ).rejects.toThrow('GITHUB_WRITE_TOKEN');
  });

  it('rejects createPullRequest without GITHUB_WRITE_TOKEN', async () => {
    delete process.env.GITHUB_WRITE_TOKEN;
    const ops = new OctokitGitHubOperations();
    await expect(ops.createPullRequest('owner', 'repo', 'feat', 'main', 'title')).rejects.toThrow(
      'GITHUB_WRITE_TOKEN',
    );
  });

  it('rejects unsupported token format before network', async () => {
    process.env.GITHUB_WRITE_TOKEN = 'bad_token';
    const ops = new OctokitGitHubOperations();
    await expect(
      ops.createOrUpdateFile('owner', 'repo', 'main', 'a.md', 'x', 'msg'),
    ).rejects.toThrow('Formato de token GitHub inválido');
  });
});

describe('OctokitGitHubOperations write operations', () => {
  const originalToken = process.env.GITHUB_WRITE_TOKEN;

  beforeEach(() => {
    process.env.GITHUB_WRITE_TOKEN = 'github_pat_write_token';
    githubWriteTotal.reset();
    githubWriteFailureTotal.reset();
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.GITHUB_WRITE_TOKEN;
    } else {
      process.env.GITHUB_WRITE_TOKEN = originalToken;
    }
  });

  it('createOrUpdateFile fetches existing blob sha and calls repos.createOrUpdateFileContents', async () => {
    const ops = new OctokitGitHubOperations();
    const getContent = vi.fn().mockResolvedValue({
      data: { sha: 'blob-sha' },
      headers: {},
    });
    const createOrUpdateFileContents = vi.fn().mockResolvedValue({
      data: {
        commit: {
          sha: 'commit-sha',
          tree: { sha: 'tree-sha' },
        },
      },
      headers: {},
    });
    ops.service.client.repos.getContent = getContent as typeof ops.service.client.repos.getContent;
    ops.service.client.repos.createOrUpdateFileContents =
      createOrUpdateFileContents as typeof ops.service.client.repos.createOrUpdateFileContents;

    const result = await ops.createOrUpdateFile(
      'owner',
      'repo',
      'main',
      'specs/a.md',
      'hello world',
      'update a.md',
    );

    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'owner', repo: 'repo', path: 'specs/a.md' }),
    );
    expect(createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        path: 'specs/a.md',
        message: 'update a.md',
        content: Buffer.from('hello world').toString('base64'),
        branch: 'main',
        sha: 'blob-sha',
      }),
    );
    expect(result).toMatchObject({
      sha: 'commit-sha',
      treeSha: 'tree-sha',
      branch: 'main',
    });
    expect(await successValue('createOrUpdateFile')).toBe(1);
    expect(await failureValue('createOrUpdateFile', 'INTERNAL')).toBe(0);
  });

  it('createOrUpdateFile creates a new file when no blob sha exists', async () => {
    const ops = new OctokitGitHubOperations();
    const getContent = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    const createOrUpdateFileContents = vi.fn().mockResolvedValue({
      data: {
        commit: {
          sha: 'commit-sha',
          tree: { sha: 'tree-sha' },
        },
      },
      headers: {},
    });
    ops.service.client.repos.getContent = getContent as typeof ops.service.client.repos.getContent;
    ops.service.client.repos.createOrUpdateFileContents =
      createOrUpdateFileContents as typeof ops.service.client.repos.createOrUpdateFileContents;

    await ops.createOrUpdateFile('owner', 'repo', 'main', 'specs/a.md', 'hello world', 'add a.md');

    expect(createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        path: 'specs/a.md',
        message: 'add a.md',
        content: Buffer.from('hello world').toString('base64'),
        branch: 'main',
      }),
    );
    expect(createOrUpdateFileContents).not.toHaveBeenCalledWith(
      expect.objectContaining({ sha: expect.any(String) }),
    );
  });

  it('batchCreateFiles builds a single commit through git data API', async () => {
    const ops = new OctokitGitHubOperations();
    const getRef = vi.fn().mockResolvedValue({
      data: { object: { sha: 'base-sha' } },
      headers: {},
    });
    const getCommit = vi.fn().mockResolvedValue({
      data: { tree: { sha: 'base-tree-sha' } },
      headers: {},
    });
    const createTree = vi.fn().mockResolvedValue({
      data: { sha: 'new-tree-sha' },
      headers: {},
    });
    const createCommit = vi.fn().mockResolvedValue({
      data: { sha: 'new-commit-sha' },
      headers: {},
    });
    const updateRef = vi.fn().mockResolvedValue({
      data: { object: { sha: 'new-commit-sha' } },
      headers: {},
    });

    ops.service.client.git.getRef = getRef as typeof ops.service.client.git.getRef;
    ops.service.client.git.getCommit = getCommit as typeof ops.service.client.git.getCommit;
    ops.service.client.git.createTree = createTree as typeof ops.service.client.git.createTree;
    ops.service.client.git.createCommit =
      createCommit as typeof ops.service.client.git.createCommit;
    ops.service.client.git.updateRef = updateRef as typeof ops.service.client.git.updateRef;

    const files = [
      { path: 'specs/a.md', content: 'A' },
      { path: 'specs/b.md', content: 'B' },
    ];
    const result = await ops.batchCreateFiles('owner', 'repo', 'main', files, 'batch commit');

    expect(getRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'heads/main' }));
    expect(getCommit).toHaveBeenCalledWith(expect.objectContaining({ commit_sha: 'base-sha' }));
    expect(createTree).toHaveBeenCalledWith(
      expect.objectContaining({
        base_tree: 'base-tree-sha',
        tree: files.map((file) => ({
          path: file.path,
          mode: '100644',
          type: 'blob',
          content: file.content,
        })),
      }),
    );
    expect(createCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'batch commit',
        tree: 'new-tree-sha',
        parents: ['base-sha'],
      }),
    );
    expect(updateRef).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: 'heads/main',
        sha: 'new-commit-sha',
      }),
    );
    expect(result).toMatchObject({
      sha: 'new-commit-sha',
      treeSha: 'new-tree-sha',
      branch: 'main',
    });
    expect(await successValue('batchCreateFiles')).toBe(1);
  });

  it('batchCreateFiles rejects empty file list before any network call', async () => {
    const ops = new OctokitGitHubOperations();
    const getRef = vi.fn();
    ops.service.client.git.getRef = getRef as typeof ops.service.client.git.getRef;

    await expect(ops.batchCreateFiles('owner', 'repo', 'main', [], 'empty')).rejects.toThrow(
      'Nenhum arquivo para commitar',
    );

    expect(getRef).not.toHaveBeenCalled();
    expect(await failureValue('batchCreateFiles', 'EMPTY_BATCH')).toBe(1);
  });

  it('batchCreateFiles is deterministic: same base and files produce same treeSha', async () => {
    const ops = new OctokitGitHubOperations();
    const getRef = vi.fn().mockResolvedValue({
      data: { object: { sha: 'base-sha' } },
      headers: {},
    });
    const getCommit = vi.fn().mockResolvedValue({
      data: { tree: { sha: 'base-tree-sha' } },
      headers: {},
    });
    const createTree = vi.fn().mockResolvedValue({
      data: { sha: 'new-tree-sha' },
      headers: {},
    });
    const createCommit = vi.fn().mockResolvedValue({
      data: { sha: 'new-commit-sha' },
      headers: {},
    });
    const updateRef = vi.fn().mockResolvedValue({
      data: { object: { sha: 'new-commit-sha' } },
      headers: {},
    });

    ops.service.client.git.getRef = getRef as typeof ops.service.client.git.getRef;
    ops.service.client.git.getCommit = getCommit as typeof ops.service.client.git.getCommit;
    ops.service.client.git.createTree = createTree as typeof ops.service.client.git.createTree;
    ops.service.client.git.createCommit =
      createCommit as typeof ops.service.client.git.createCommit;
    ops.service.client.git.updateRef = updateRef as typeof ops.service.client.git.updateRef;

    const files = [{ path: 'specs/a.md', content: 'A' }];
    const first = await ops.batchCreateFiles('owner', 'repo', 'main', files, 'msg');
    const second = await ops.batchCreateFiles('owner', 'repo', 'main', files, 'msg');

    // createTree is called with identical arguments both times, so the treeSha would be identical
    // in a real Git backend. Here the mock returns a fixed value, so we assert the call args match.
    expect(createTree).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        base_tree: 'base-tree-sha',
        tree: [{ path: 'specs/a.md', mode: '100644', type: 'blob', content: 'A' }],
      }),
    );
    expect(createTree).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        base_tree: 'base-tree-sha',
        tree: [{ path: 'specs/a.md', mode: '100644', type: 'blob', content: 'A' }],
      }),
    );
    expect(first.treeSha).toBe(second.treeSha);
  });

  it('createPullRequest calls pulls.create and returns number and url', async () => {
    const ops = new OctokitGitHubOperations();
    const create = vi.fn().mockResolvedValue({
      data: { number: 42, html_url: 'https://github.com/owner/repo/pull/42' },
      headers: {},
    });
    ops.service.client.pulls.create = create as typeof ops.service.client.pulls.create;

    const result = await ops.createPullRequest(
      'owner',
      'repo',
      'feature-branch',
      'main',
      'Add feature',
      'PR body',
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        title: 'Add feature',
        head: 'feature-branch',
        base: 'main',
        body: 'PR body',
      }),
    );
    expect(result).toMatchObject({
      number: 42,
      url: 'https://github.com/owner/repo/pull/42',
    });
    expect(await successValue('createPullRequest')).toBe(1);
  });
});

describe('OctokitGitHubOperations error translation', () => {
  const originalToken = process.env.GITHUB_WRITE_TOKEN;

  beforeEach(() => {
    process.env.GITHUB_WRITE_TOKEN = 'github_pat_write_token';
    githubWriteTotal.reset();
    githubWriteFailureTotal.reset();
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.GITHUB_WRITE_TOKEN;
    } else {
      process.env.GITHUB_WRITE_TOKEN = originalToken;
    }
  });

  it('translates 403 to FORBIDDEN', async () => {
    const ops = new OctokitGitHubOperations();
    ops.service.client.repos.getContent = vi.fn().mockResolvedValue({
      data: { sha: 'blob-sha' },
    }) as typeof ops.service.client.repos.getContent;
    const error = createApiError(403, 'Forbidden');
    ops.service.client.repos.createOrUpdateFileContents = vi
      .fn()
      .mockRejectedValue(
        error,
      ) as unknown as typeof ops.service.client.repos.createOrUpdateFileContents;

    await expect(
      ops.createOrUpdateFile('owner', 'repo', 'main', 'a.md', 'x', 'msg'),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('Permissão insuficiente'),
    });
    expect(await failureValue('createOrUpdateFile', 'FORBIDDEN')).toBe(1);
  });

  it('translates 404 to NOT_FOUND', async () => {
    const ops = new OctokitGitHubOperations();
    const error = createApiError(404, 'Not Found');
    ops.service.client.git.getRef = vi
      .fn()
      .mockRejectedValue(error) as unknown as typeof ops.service.client.git.getRef;

    await expect(
      ops.batchCreateFiles('owner', 'repo', 'main', [{ path: 'a.md', content: 'x' }], 'msg'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('inexistente'),
    });
    expect(await failureValue('batchCreateFiles', 'NOT_FOUND')).toBe(1);
  });

  it('translates 409 to BASE_CONFLICT', async () => {
    const ops = new OctokitGitHubOperations();
    ops.service.client.repos.getContent = vi.fn().mockResolvedValue({
      data: { sha: 'blob-sha' },
    }) as typeof ops.service.client.repos.getContent;
    const error = createApiError(409, 'Conflict');
    ops.service.client.repos.createOrUpdateFileContents = vi
      .fn()
      .mockRejectedValue(
        error,
      ) as unknown as typeof ops.service.client.repos.createOrUpdateFileContents;

    await expect(
      ops.createOrUpdateFile('owner', 'repo', 'main', 'a.md', 'x', 'msg'),
    ).rejects.toMatchObject({
      code: 'BASE_CONFLICT',
      message: expect.stringContaining('avançou'),
    });
  });

  it('translates 422 to BASE_CONFLICT', async () => {
    const ops = new OctokitGitHubOperations();
    const error = createApiError(422, 'Unprocessable');
    ops.service.client.pulls.create = vi
      .fn()
      .mockRejectedValue(error) as unknown as typeof ops.service.client.pulls.create;

    await expect(
      ops.createPullRequest('owner', 'repo', 'feat', 'main', 'title'),
    ).rejects.toMatchObject({
      code: 'BASE_CONFLICT',
    });
  });
});
