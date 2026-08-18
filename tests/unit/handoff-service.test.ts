import { describe, it, expect, vi, beforeEach } from 'vitest';

const buildHandoffFiles = vi.hoisted(() => vi.fn());
const commitHandoffToRepo = vi.hoisted(() => vi.fn());
const findByIdOrNull = vi.hoisted(() => vi.fn());
const getFlags = vi.hoisted(() => vi.fn());

vi.mock('../../server/services/handoff-bundle', () => ({ buildHandoffFiles }));
vi.mock('../../server/services/handoff-commit', () => ({ commitHandoffToRepo }));
vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: { findByIdOrNull },
}));
vi.mock('../../server/services/feature-flags', () => ({ featureFlags: { getFlags } }));
vi.mock('../../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  generateAndCommit,
  __resetHandoffServiceState,
} from '../../server/services/handoff-service';

const FILES = {
  files: [
    { path: 'spec.md', content: '#' },
    { path: 'tasks.md', content: '#' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetHandoffServiceState();
  buildHandoffFiles.mockResolvedValue(FILES);
  findByIdOrNull.mockResolvedValue({ id: 1, repoFullName: 'owner/repo' });
  getFlags.mockReturnValue({ handoffAutoCommitEnabled: true });
  process.env.GITHUB_WRITE_TOKEN = 'tok';
});

describe('generateAndCommit (spec 10007)', () => {
  it('flag off → só gera (não commita)', async () => {
    getFlags.mockReturnValue({ handoffAutoCommitEnabled: false });
    const r = await generateAndCommit(1);
    expect(r.status).toBe('generated');
    expect(r.fileCount).toBe(2);
    expect(commitHandoffToRepo).not.toHaveBeenCalled();
  });

  it('sem GITHUB_WRITE_TOKEN → só gera', async () => {
    delete process.env.GITHUB_WRITE_TOKEN;
    const r = await generateAndCommit(1);
    expect(r.status).toBe('generated');
    expect(commitHandoffToRepo).not.toHaveBeenCalled();
  });

  it('sem repoFullName → só gera', async () => {
    findByIdOrNull.mockResolvedValue({ id: 1, repoFullName: null });
    const r = await generateAndCommit(1);
    expect(r.status).toBe('generated');
  });

  it('elegível + commit ok → committed com hash', async () => {
    commitHandoffToRepo.mockResolvedValue({ sha: 'abc123' });
    const r = await generateAndCommit(1);
    expect(r.status).toBe('committed');
    expect(r.commitHash).toBe('abc123');
    expect(r.attempts).toBe(1);
  });

  it('commit falha 3× → pending_retry', async () => {
    commitHandoffToRepo.mockRejectedValue(new Error('403'));
    const r = await generateAndCommit(1);
    expect(r.status).toBe('pending_retry');
    expect(r.attempts).toBe(3);
    expect(commitHandoffToRepo).toHaveBeenCalledTimes(3);
    expect(r.error).toContain('403');
  }, 10_000);

  it('idempotente: 2ª chamada após committed não re-commita (FR-009)', async () => {
    commitHandoffToRepo.mockResolvedValue({ sha: 'abc123' });
    await generateAndCommit(1);
    const second = await generateAndCommit(1);
    expect(second.status).toBe('committed');
    expect(commitHandoffToRepo).toHaveBeenCalledTimes(1);
  });
});
