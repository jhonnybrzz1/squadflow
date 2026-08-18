/**
 * Spec 026 — commitar o handoff no repositório destino.
 * Usa GitHubOperations mockado — nenhuma escrita real em repositório.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const repoMock = vi.hoisted(() => ({ findByIdOrNull: vi.fn() }));
const filesMock = vi.hoisted(() => ({ buildHandoffFiles: vi.fn() }));

vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: repoMock,
}));
vi.mock('../../server/services/handoff-bundle', () => ({
  buildHandoffFiles: filesMock.buildHandoffFiles,
}));

import { AppError, NotFoundError } from '../../server/middleware/error-handler';
import { commitHandoffToRepo } from '../../server/services/handoff-commit';
import type { GitHubOperations } from '@shared/github-operations';

function makeOps() {
  return {
    batchCreateFiles: vi.fn(async () => ({
      sha: 'commit-sha-1',
      treeSha: 'tree-sha-1',
      branch: 'main',
    })),
    createOrUpdateFile: vi.fn(),
    createPullRequest: vi.fn(),
  } satisfies GitHubOperations;
}

const demand = {
  id: 10002,
  title: 'Criar agente de prospecção',
  repoFullName: 'example-org/projetosquad1',
};

const handoffFiles = {
  files: [
    { path: 'specs/10002-handoff/spec.md', content: '# PRD' },
    { path: 'specs/10002-handoff/tasks.md', content: '# Tasks' },
    { path: '.specify/memory/constitution.md', content: '# Constituição' },
    { path: 'manifest.json', content: '{}' },
  ],
  manifest: {},
  filename: 'demanda-10002-handoff.zip',
};

beforeEach(() => {
  vi.clearAllMocks();
  repoMock.findByIdOrNull.mockResolvedValue(demand);
  filesMock.buildHandoffFiles.mockResolvedValue(handoffFiles);
});

describe('commitHandoffToRepo', () => {
  it('commita os arquivos do handoff no repo da demanda num único commit atômico', async () => {
    const ops = makeOps();
    const result = await commitHandoffToRepo(10002, ops, { branch: 'main' });

    expect(ops.batchCreateFiles).toHaveBeenCalledTimes(1);
    const [owner, repo, branch, files, message] = ops.batchCreateFiles.mock.calls[0];
    expect(owner).toBe('example-org');
    expect(repo).toBe('projetosquad1');
    expect(branch).toBe('main');
    expect(files.map((f) => f.path)).toEqual([
      'specs/10002-handoff/spec.md',
      'specs/10002-handoff/tasks.md',
      '.specify/memory/constitution.md',
      'manifest.json',
    ]);
    expect(message).toContain('10002');

    expect(result).toMatchObject({
      owner: 'example-org',
      repo: 'projetosquad1',
      sha: 'commit-sha-1',
      treeSha: 'tree-sha-1',
      fileCount: 4,
    });
  });

  it('demanda inexistente → NotFoundError, sem escrita', async () => {
    repoMock.findByIdOrNull.mockResolvedValue(null);
    const ops = makeOps();
    await expect(commitHandoffToRepo(999, ops)).rejects.toBeInstanceOf(NotFoundError);
    expect(ops.batchCreateFiles).not.toHaveBeenCalled();
  });

  it('demanda sem repositório associado → 422 HANDOFF_NO_REPO, sem escrita', async () => {
    repoMock.findByIdOrNull.mockResolvedValue({ ...demand, repoFullName: null });
    const ops = makeOps();
    const err = await commitHandoffToRepo(10002, ops).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(422);
    expect(err.errorCode).toBe('HANDOFF_NO_REPO');
    expect(ops.batchCreateFiles).not.toHaveBeenCalled();
  });

  it('propaga o 422 de PRD ausente vindo de buildHandoffFiles, sem escrita', async () => {
    filesMock.buildHandoffFiles.mockRejectedValue(
      new AppError('PRD ausente', 422, 'HANDOFF_PRD_MISSING'),
    );
    const ops = makeOps();
    const err = await commitHandoffToRepo(10002, ops).catch((e) => e);
    expect(err.errorCode).toBe('HANDOFF_PRD_MISSING');
    expect(ops.batchCreateFiles).not.toHaveBeenCalled();
  });

  it('usa a branch informada e uma mensagem de commit customizada', async () => {
    const ops = makeOps();
    await commitHandoffToRepo(10002, ops, { branch: 'develop', message: 'msg custom' });
    const [, , branch, , message] = ops.batchCreateFiles.mock.calls[0];
    expect(branch).toBe('develop');
    expect(message).toBe('msg custom');
  });
});
