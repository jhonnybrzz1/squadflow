import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextBuilder, localPathExistsWithinRoot } from '../../server/services/context-builder';
import { pathValidationCache } from '../../server/services/evidence-policy';
import { repoService } from '../../server/services/repo-service';
import { gitHubService } from '../../server/services/github';
import { logger } from '../../server/utils/logger';

vi.mock('../../server/services/repo-service', () => ({
  repoService: {
    getOrCreateRepo: vi.fn(),
    getRepoWithFiles: vi.fn(),
  },
}));

vi.mock('../../server/services/github', () => ({
  gitHubService: {
    verifyFilesExist: vi.fn(),
    searchRepo: vi.fn(),
    getFileContent: vi.fn(),
  },
}));

function responseWithPaths(paths: string[], revision = 'spec-007'): string {
  return `**Análise:** Evidência verificada.
**Recomendação:** Prosseguir.
**ROI:** A MEDIR — sem baseline
**Esforço:** 1 dia
**Prioridade:** Importante

**Evidence Block:**
\`\`\`json
{
  "sourceType": "direct_read",
  "repoContext": { "owner": "owner", "repo": "repo", "branch": "${revision}" },
  "evidenceFiles": ${JSON.stringify(paths)}
}
\`\`\``;
}

describe('evidence validation flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pathValidationCache.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blocks every cited path when there is no usable repository', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const result = await contextBuilder.validateResponse(responseWithPaths(['src/a.ts']), {
      demandType: 'melhoria',
      repoAvailable: false,
      repoId: 'none',
      demandId: 7,
    });

    expect(result.evidence).toMatchObject({ sourceType: 'blocked', evidenceFiles: [] });
    expect(result.pathValidation).toEqual({
      validPaths: [],
      rejectedPaths: ['src/a.ts'],
      unverifiablePaths: [],
      block: true,
      reason: 'no_repository',
    });
    expect(JSON.stringify(info.mock.calls)).toContain('hallucinated_path_blocked');
  });

  it('blocks cited paths through the demand-aware agent validation API', async () => {
    const demand = {
      id: 71,
      description: 'Demanda conceitual sem repositório.',
      type: 'melhoria',
    } as never;

    const result = await contextBuilder.validateAgentResponse(
      responseWithPaths(['src/forbidden.ts']),
      demand,
    );

    expect(result.pathValidation).toMatchObject({
      rejectedPaths: ['src/forbidden.ts'],
      block: true,
      reason: 'no_repository',
    });
  });

  it('prefers the repository state established while building the demand context', async () => {
    const demand = {
      id: 72,
      description: 'Repositório: owner/repo',
      repoFullName: 'owner/repo',
      type: 'bug',
    } as never;
    vi.spyOn(contextBuilder, 'getRepositoryValidationContext').mockReturnValue({
      repoAvailable: false,
      repoId: 'owner/repo',
    });

    const result = await contextBuilder.validateAgentResponse(
      responseWithPaths(['src/unavailable.ts']),
      demand,
    );

    expect(result.pathValidation).toMatchObject({
      rejectedPaths: ['src/unavailable.ts'],
      block: true,
      reason: 'no_repository',
    });
  });

  it('keeps existing relative paths and rejects confirmed missing paths', async () => {
    vi.mocked(repoService.getRepoWithFiles).mockResolvedValue({
      files: [{ path: 'src/exists.ts' }],
    } as never);

    const result = await contextBuilder.validateResponse(
      responseWithPaths(['src/exists.ts', 'src/missing.ts']),
      { demandType: 'bug', repoAvailable: true, repoId: 'owner/repo' },
    );

    expect(result.evidence?.evidenceFiles).toEqual(['src/exists.ts']);
    expect(result.pathValidation.validPaths).toEqual(['src/exists.ts']);
    expect(result.pathValidation.rejectedPaths).toEqual(['src/missing.ts']);
    expect(result.pathValidation).toMatchObject({ block: true, reason: 'path_not_found' });
  });

  it('does not turn a source outage into path_not_found or a valid path', async () => {
    vi.mocked(repoService.getRepoWithFiles).mockResolvedValue(null);
    vi.mocked(gitHubService.verifyFilesExist).mockRejectedValue(new Error('unavailable'));

    const result = await contextBuilder.validateResponse(responseWithPaths(['src/unknown.ts']), {
      demandType: 'bug',
      repoAvailable: true,
      repoId: 'owner/repo',
    });

    expect(result.pathValidation.unverifiablePaths).toEqual(['src/unknown.ts']);
    expect(result.pathValidation.validPaths).toEqual([]);
    expect(result.pathValidation.rejectedPaths).toEqual([]);
    expect(result.pathValidation.block).toBe(false);
    expect(result.pathValidation.reason).toBeNull();
  });

  it('keeps free-text paths unverifiable when the repository source is unavailable', async () => {
    vi.mocked(repoService.getRepoWithFiles).mockResolvedValue(null);
    vi.mocked(gitHubService.verifyFilesExist).mockRejectedValue(new Error('unavailable'));
    const document = `# Documento

Consultar src/unavailable.ts antes de decidir.

**Evidence Block:**
\`\`\`json
{
  "sourceType": "blocked",
  "repoContext": { "owner": "owner", "repo": "repo", "branch": "main" },
  "evidenceFiles": []
}
\`\`\``;

    const result = await contextBuilder.validateDocumentEvidence(document, {
      demandType: 'bug',
      repoAvailable: true,
      repoId: 'owner/repo',
    });

    expect(result.pathValidation.unverifiablePaths).toContain('src/unavailable.ts');
    expect(result.pathValidation.rejectedPaths).not.toContain('src/unavailable.ts');
    expect(result.issues.some((issue) => issue.includes('NÃO VERIFICÁVEL'))).toBe(true);
    expect(result.issues.some((issue) => issue.includes('NÃO EXISTEM'))).toBe(false);
  });

  it.each([
    '/etc/passwd.ts',
    'C:\\temp\\secret.ts',
    '../outside.ts',
    'src/../../outside.ts',
    'src/*.ts',
  ])('rejects unsafe path %s before consulting a source', async (unsafePath) => {
    const result = await contextBuilder.validateResponse(responseWithPaths([unsafePath]), {
      demandType: 'bug',
      repoAvailable: true,
      repoId: 'owner/repo',
    });

    expect(result.pathValidation).toMatchObject({
      rejectedPaths: [unsafePath],
      block: true,
      reason: 'unsafe_path',
    });
    expect(repoService.getRepoWithFiles).not.toHaveBeenCalled();
    expect(gitHubService.verifyFilesExist).not.toHaveBeenCalled();
  });

  it('keeps paths unverifiable when direct_read omits repoContext', async () => {
    const response = `**Análise:** Evidência incompleta.
**Recomendação:** Verificar.
**ROI:** A MEDIR — sem baseline
**Esforço:** 1 dia
**Prioridade:** Importante

**Evidence Block:**
\`\`\`json
{ "sourceType": "direct_read", "evidenceFiles": ["src/unknown.ts"] }
\`\`\``;

    const result = await contextBuilder.validateResponse(response, {
      demandType: 'bug',
      repoAvailable: true,
      repoId: 'owner/repo',
    });

    expect(result.pathValidation.unverifiablePaths).toEqual(['src/unknown.ts']);
    expect(result.pathValidation.block).toBe(false);
    expect(repoService.getRepoWithFiles).not.toHaveBeenCalled();
  });

  it('uses the path cache on the second validation', async () => {
    vi.mocked(repoService.getRepoWithFiles).mockResolvedValue({
      files: [{ path: 'src/cached.ts' }],
    } as never);
    const response = responseWithPaths(['src/cached.ts'], 'cache-revision');

    await contextBuilder.validateResponse(response, { repoAvailable: true, repoId: 'owner/repo' });
    await contextBuilder.validateResponse(response, { repoAvailable: true, repoId: 'owner/repo' });

    expect(repoService.getRepoWithFiles).toHaveBeenCalledTimes(1);
  });

  it('rejects a symlink that resolves outside the repository root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-outside-'));
    const outsideFile = path.join(outside, 'secret.ts');
    fs.writeFileSync(outsideFile, 'secret');
    fs.symlinkSync(outsideFile, path.join(root, 'link.ts'));

    expect(localPathExistsWithinRoot('link.ts', root)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('injects the blocked contract and baseline integrity directive without a repository', async () => {
    const demand = {
      id: 7007,
      title: 'Melhoria conceitual',
      description: 'Demanda sem repositório associado.',
      type: 'melhoria',
      priority: 'media',
    } as never;

    const context = await contextBuilder.buildContext(demand);
    expect(context).toContain('CONTRATO DE AUSÊNCIA DE REPOSITÓRIO');
    expect(context).toContain('"sourceType": "blocked"');
    expect(context).toContain('A MEDIR — sem baseline');
  });
});
