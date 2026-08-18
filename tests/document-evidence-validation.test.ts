import { describe, it, expect, vi, beforeEach } from 'vitest';
import { contextBuilder } from '../server/services/context-builder';
import { repoService } from '../server/services/repo-service';
import { gitHubService } from '../server/services/github';
import { pathValidationCache } from '../server/services/evidence-policy';

vi.mock('../server/services/repo-service', () => ({
  repoService: {
    getOrCreateRepo: vi.fn(),
    getRepoWithFiles: vi.fn(),
  },
}));

vi.mock('../server/services/github', () => ({
  gitHubService: {
    verifyFilesExist: vi.fn(),
  },
}));

/**
 * `validateDocumentEvidence` reuses the same file-existence check as
 * `validateResponse` but skips the agent-message structural checks
 * (Análise/ROI/Esforço/Prioridade). It is meant for aggregated documents
 * like PRDs and TDDs, where the model used to hallucinate file paths
 * because nothing validated the evidence block at that layer.
 */
describe('validateDocumentEvidence', () => {
  const owner = 'example-org';
  const repoName = 'AiChatFlow1';

  beforeEach(() => {
    vi.clearAllMocks();
    pathValidationCache.clear();
  });

  it('returns a clean message without the Evidence Block markup when valid', async () => {
    (repoService.getRepoWithFiles as any).mockResolvedValue({
      id: 1,
      owner,
      name: repoName,
      files: [{ path: 'server/services/sse/manager.ts' }],
    });

    const prdMarkdown = `# PRD - Realtime fix

## 1. Decisão De Produto
Conectar o frontend ao SSE existente.

## Evidências do Refinamento
- Backend já emite eventos SSE em server/services/sse/manager.ts

**Evidence Block:**
\`\`\`json
{
  "sourceType": "direct_read",
  "repoContext": { "owner": "${owner}", "repo": "${repoName}", "branch": "main" },
  "evidenceFiles": ["server/services/sse/manager.ts"]
}
\`\`\`
`;

    const result = await contextBuilder.validateDocumentEvidence(prdMarkdown);

    expect(result.evidence?.sourceType).toBe('direct_read');
    expect(result.evidence?.evidenceFiles).toEqual(['server/services/sse/manager.ts']);
    expect(result.cleanMessage).not.toContain('**Evidence Block:**');
    expect(result.cleanMessage).not.toContain('"sourceType"');
    expect(result.issues).toHaveLength(0);
  });

  it('downgrades sourceType to blocked when all cited files are hallucinated (the regression that motivated this fix)', async () => {
    (repoService.getRepoWithFiles as any).mockResolvedValue(null);
    (gitHubService.verifyFilesExist as any).mockResolvedValue({
      existing: [],
      missing: ['server/events/RefinementEvents.ts', 'client/src/components/RefinementChat.tsx'],
    });

    const prdMarkdown = `# PRD - Realtime fix

## Evidências do Refinamento
- Tech Lead confirmou eventos refinement:update via WebSocket

**Evidence Block:**
\`\`\`json
{
  "sourceType": "direct_read",
  "repoContext": { "owner": "${owner}", "repo": "${repoName}", "branch": "main" },
  "evidenceFiles": ["server/events/RefinementEvents.ts", "client/src/components/RefinementChat.tsx"]
}
\`\`\`
`;

    const result = await contextBuilder.validateDocumentEvidence(prdMarkdown);

    expect(result.evidence?.sourceType).toBe('blocked');
    expect(result.evidence?.evidenceFiles).toEqual([]);
    expect(result.evidence?.evidenceNotes).toMatch(/Nenhum arquivo de evidência/);
    expect(result.issues.some((i) => i.includes('NÃO EXISTEM'))).toBe(true);
    expect(result.cleanMessage).not.toContain('"sourceType"');
  });

  it('keeps the document body intact when no Evidence Block is present (no JSON to strip)', async () => {
    const prdMarkdown = `# PRD - Realtime fix

## 1. Decisão De Produto
Conectar o frontend ao SSE existente.`;

    const result = await contextBuilder.validateDocumentEvidence(prdMarkdown);

    expect(result.evidence).toBeUndefined();
    expect(result.cleanMessage).toBe(prdMarkdown);
    expect(result.issues).toContain(
      'Evidence Block: Bloco de evidência obrigatório não encontrado',
    );
  });

  it('does NOT apply agent-message structural rules (Análise/ROI/Esforço) — documents have a different shape', async () => {
    (repoService.getRepoWithFiles as any).mockResolvedValue({
      id: 1,
      owner,
      name: repoName,
      files: [{ path: 'README.md' }],
    });

    // Note: no **Análise:** / **ROI:** / **Esforço:** — would fail validateResponse,
    // but validateDocumentEvidence focuses ONLY on the evidence block.
    const prdMarkdown = `# PRD - Something

**Evidence Block:**
\`\`\`json
{
  "sourceType": "direct_read",
  "repoContext": { "owner": "${owner}", "repo": "${repoName}", "branch": "main" },
  "evidenceFiles": ["README.md"]
}
\`\`\``;

    const result = await contextBuilder.validateDocumentEvidence(prdMarkdown);

    expect(result.evidence?.sourceType).toBe('direct_read');
    expect(result.evidence?.evidenceFiles).toEqual(['README.md']);
    // No structural complaints about missing **Análise**/**ROI**.
    expect(result.issues).toHaveLength(0);
  });

  it('partially trims hallucinated paths when some files exist (sourceType stays direct_read with a warning)', async () => {
    (repoService.getRepoWithFiles as any).mockResolvedValue({
      id: 1,
      owner,
      name: repoName,
      files: [{ path: 'server/services/sse/manager.ts' }],
    });

    const prdMarkdown = `# PRD

**Evidence Block:**
\`\`\`json
{
  "sourceType": "direct_read",
  "repoContext": { "owner": "${owner}", "repo": "${repoName}", "branch": "main" },
  "evidenceFiles": [
    "server/services/sse/manager.ts",
    "server/events/RefinementEvents.ts"
  ]
}
\`\`\``;

    const result = await contextBuilder.validateDocumentEvidence(prdMarkdown);

    expect(result.evidence?.sourceType).toBe('direct_read');
    expect(result.evidence?.evidenceFiles).toEqual(['server/services/sse/manager.ts']);
    expect(result.evidence?.evidenceNotes).toMatch(/1 arquivo\(s\) removido/);
  });

  it('flags hallucinated file paths cited in the document body even when the Evidence Block is blocked', async () => {
    (repoService.getRepoWithFiles as any).mockResolvedValue({
      id: 1,
      owner,
      name: repoName,
      files: [
        { path: 'server/services/ai-usage-tracker.ts' },
        { path: 'server/services/tool-telemetry.ts' },
        { path: 'server/services/agent-tools-registry.ts' },
      ],
    });

    const prdMarkdown = `# PRD - Auditoria Tools/APIs

## Prontidão
Instrumentar server/services/ai-client.ts.

## Fazer Agora
Adicionar tracing em server/cognitive-core/tools/ e shared/types/tool.ts.

**Evidence Block:**
\`\`\`json
{
  "sourceType": "blocked",
  "repoContext": { "owner": "${owner}", "repo": "${repoName}", "branch": "main" },
  "evidenceFiles": []
}
\`\`\``;

    const result = await contextBuilder.validateDocumentEvidence(prdMarkdown);

    const freeTextIssue = result.issues.find((issue) => issue.startsWith('Texto livre:'));
    expect(freeTextIssue).toBeDefined();
    expect(freeTextIssue).toContain('server/services/ai-client.ts');
    expect(freeTextIssue).toContain('server/cognitive-core/tools/');
    expect(freeTextIssue).toContain('shared/types/tool.ts');
    expect(result.evidence?.evidenceNotes).toMatch(/server\/services\/ai-client\.ts/);
    expect(result.evidence?.sourceType).toBe('blocked');
  });
});
