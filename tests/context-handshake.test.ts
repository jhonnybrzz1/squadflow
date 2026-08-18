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

describe('Context Handshake - Evidence Validation', () => {
  const owner = 'test-owner';
  const repoName = 'test-repo';

  beforeEach(() => {
    vi.clearAllMocks();
    pathValidationCache.clear();
  });

  it('deve validar com sucesso uma evidência direct_read correta', async () => {
    const mockRepo = {
      id: 1,
      owner,
      name: repoName,
      files: [{ path: 'file1.ts' }, { path: 'file2.ts' }, { path: 'file3.ts' }],
    };
    (repoService.getRepoWithFiles as any).mockResolvedValue(mockRepo);

    const response = `
**Análise:** O arquivo file1.ts tem 100 linhas de código.
**Problema Identificado:** N/A
**Impacto:** Alto
**Recomendação:** Teste
**ROI:** 1:1
**Esforço:** 1 dia
**Prioridade:** Importante

**Evidence Block:**
\`\`\`json
{
  "sourceType": "direct_read",
  "repoContext": { "owner": "${owner}", "repo": "${repoName}", "branch": "main" },
  "evidenceFiles": ["file1.ts", "file2.ts", "file3.ts"]
}
\`\`\`
`;

    const result = await contextBuilder.validateResponse(response);
    if (result.issues.length > 0) console.log('Issues Validação 1:', result.issues);

    expect(result.isValid).toBe(true);
    expect(result.evidence?.sourceType).toBe('direct_read');
    expect(result.evidence?.evidenceFiles).toHaveLength(3);
    expect(result.issues).toHaveLength(0);
  });

  it('deve marcar como blocked se TODOS os arquivos não existirem no repo', async () => {
    const mockRepo = {
      id: 1,
      owner,
      name: repoName,
      files: [{ path: 'other-file.ts' }], // Nenhum dos arquivos de evidência existe
    };
    (repoService.getRepoWithFiles as any).mockResolvedValue(mockRepo);

    const response = `
**Análise:** O arquivo file1.ts tem 100 linhas de código.
**Problema Identificado:** N/A
**Impacto:** Alto
**Recomendação:** Teste
**ROI:** 1:1
**Esforço:** 1 dia
**Prioridade:** Importante

**Evidence Block:**
\`\`\`json
{
  "sourceType": "direct_read",
  "repoContext": { "owner": "${owner}", "repo": "${repoName}", "branch": "main" },
  "evidenceFiles": ["non-existent1.ts", "non-existent2.ts"]
}
\`\`\`
`;

    const result = await contextBuilder.validateResponse(response);

    // Quando TODOS os arquivos são inválidos, sourceType muda para blocked
    expect(result.evidence?.sourceType).toBe('blocked');
    expect(result.issues.some((i) => i.includes('NÃO EXISTEM'))).toBe(true);
  });

  it('deve manter direct_read mas adicionar issue se ALGUNS arquivos não existirem', async () => {
    const mockRepo = {
      id: 1,
      owner,
      name: repoName,
      files: [{ path: 'file1.ts' }], // Apenas file1.ts existe
    };
    (repoService.getRepoWithFiles as any).mockResolvedValue(mockRepo);

    const response = `
**Análise:** O arquivo file1.ts tem 100 linhas de código.
**Problema Identificado:** N/A
**Impacto:** Alto
**Recomendação:** Teste
**ROI:** 1:1
**Esforço:** 1 dia
**Prioridade:** Importante

**Evidence Block:**
\`\`\`json
{
  "sourceType": "direct_read",
  "repoContext": { "owner": "${owner}", "repo": "${repoName}", "branch": "main" },
  "evidenceFiles": ["file1.ts", "file2.ts", "non-existent.ts"]
}
\`\`\`
`;

    const result = await contextBuilder.validateResponse(response);

    // Quando alguns arquivos existem, sourceType permanece direct_read
    // mas os arquivos inexistentes são removidos da lista
    expect(result.evidence?.sourceType).toBe('direct_read');
    expect(result.evidence?.evidenceFiles).toEqual(['file1.ts']);
    expect(result.issues.some((i) => i.includes('NÃO EXISTEM'))).toBe(true);
  });

  it('deve verificar via GitHub API se repo não estiver no cache local', async () => {
    (repoService.getRepoWithFiles as any).mockResolvedValue(null);
    (gitHubService.verifyFilesExist as any).mockResolvedValue({
      existing: ['file1.ts', 'file2.ts'],
      missing: ['file3.ts'],
    });

    const response = `
**Análise:** O arquivo file1.ts tem 100 linhas de código.
**Problema Identificado:** N/A
**Impacto:** Alto
**Recomendação:** Teste
**ROI:** 1:1
**Esforço:** 1 dia
**Prioridade:** Importante

**Evidence Block:**
\`\`\`json
{
  "sourceType": "direct_read",
  "repoContext": { "owner": "${owner}", "repo": "${repoName}", "branch": "main" },
  "evidenceFiles": ["file1.ts", "file2.ts", "file3.ts"]
}
\`\`\`
`;

    const result = await contextBuilder.validateResponse(response);

    // Verificação via API foi feita, alguns arquivos existem
    expect(result.evidence?.sourceType).toBe('direct_read');
    expect(result.evidence?.evidenceFiles).toEqual(['file1.ts', 'file2.ts']);
    expect(result.issues.some((i) => i.includes('GitHub API'))).toBe(true);
  });

  it('deve marcar como não verificável se API falhar, sem tratar como inexistente', async () => {
    (repoService.getRepoWithFiles as any).mockResolvedValue(null);
    (gitHubService.verifyFilesExist as any).mockRejectedValue(new Error('API Error'));

    const response = `
**Análise:** O arquivo file1.ts tem 100 linhas de código.
**Problema Identificado:** N/A
**Impacto:** Alto
**Recomendação:** Teste
**ROI:** 1:1
**Esforço:** 1 dia
**Prioridade:** Importante

**Evidence Block:**
\`\`\`json
{
  "sourceType": "direct_read",
  "repoContext": { "owner": "${owner}", "repo": "${repoName}", "branch": "main" },
  "evidenceFiles": ["file1.ts", "file2.ts", "file3.ts"]
}
\`\`\`
`;

    const result = await contextBuilder.validateResponse(response);

    expect(result.evidence?.sourceType).toBe('direct_read');
    expect(result.evidence?.evidenceFiles).toEqual(['file1.ts', 'file2.ts', 'file3.ts']);
    expect(result.pathValidation.unverifiablePaths).toEqual(['file1.ts', 'file2.ts', 'file3.ts']);
    expect(result.pathValidation.block).toBe(false);
    expect(result.issues.some((i) => i.includes('NÃO VERIFICÁVEL'))).toBe(true);
    expect(result.issues.some((i) => i.includes('NÃO EXISTEM'))).toBe(false);
  });

  it('deve falhar se o Evidence Block estiver ausente', async () => {
    const response = `**Análise:** Teste\n**Recomendação:** Teste\n**ROI:** 1:1\n**Esforço:** 1 dia\n**Prioridade:** Importante`;
    const result = await contextBuilder.validateResponse(response);

    expect(result.isValid).toBe(false);
    expect(result.issues).toContain(
      'Evidence Block: Bloco de evidência obrigatório não encontrado',
    );
  });

  it('expõe o gate de resposta no contrato unificado (severity + category)', async () => {
    // Sem Evidence Block e sem referências concretas: gera 1 erro (bloco obrigatório,
    // hard block) + ao menos 1 warning (dados concretos), no mesmo contrato tiered
    // (severity/category) usado pelos validadores de improvement-execution.
    const response = `**Análise:** Teste\n**Recomendação:** Teste\n**ROI:** 1:1\n**Esforço:** 1 dia\n**Prioridade:** Importante`;
    const result = await contextBuilder.validateResponse(response);

    const blocking = result.structuredIssues.filter((i) => i.severity === 'error');
    const warnings = result.structuredIssues.filter((i) => i.severity === 'warning');

    expect(blocking.length).toBeGreaterThan(0);
    expect(blocking[0].message).toContain('obrigatório não encontrado');
    expect(blocking[0].category).toBe('semantic');
    expect(warnings.length).toBeGreaterThan(0);
    // issues (string[]) espelha exatamente as mensagens estruturadas (compatibilidade)
    expect(result.issues).toEqual(result.structuredIssues.map((i) => i.message));
    // isValid permanece falso por haver issue 'error' (regra de bloco obrigatório)
    expect(result.isValid).toBe(false);
  });

  it('A1: Evidence Block com estrutura inválida (sourceType fora do enum) vira issue de schema zod', async () => {
    // sourceType inválido: o schema zod rejeita e produz uma issue estruturada, em
    // vez de construir um EvidenceBlock inconsistente (parse antigo não validava).
    const response = `**Análise:** Teste\n**Recomendação:** Teste\n**ROI:** 1:1\n**Esforço:** 1 dia\n**Prioridade:** Importante\n\n**Evidence Block:**\n\`\`\`json\n{ "sourceType": "telepatia", "repoContext": { "owner": "o", "repo": "r" }, "evidenceFiles": [] }\n\`\`\``;
    const result = await contextBuilder.validateResponse(response);

    expect(result.evidence).toBeUndefined();
    expect(result.issues.some((i) => i.includes('Estrutura inválida'))).toBe(true);
    expect(
      result.structuredIssues.some(
        (i) => i.section === 'Evidence Block' && i.message.includes('Estrutura inválida'),
      ),
    ).toBe(true);
  });

  it('deve verificar existência de arquivos também em fallback_rag', async () => {
    const mockRepo = {
      id: 1,
      owner,
      name: repoName,
      files: [{ path: 'file1.ts' }],
    };
    (repoService.getRepoWithFiles as any).mockResolvedValue(mockRepo);

    const response = `
**Análise:** Busca semântica retornou arquivos.
**Problema Identificado:** N/A
**Impacto:** Alto
**Recomendação:** Teste
**ROI:** 1:1
**Esforço:** 1 dia
**Prioridade:** Importante

**Evidence Block:**
\`\`\`json
{
  "sourceType": "fallback_rag",
  "repoContext": { "owner": "${owner}", "repo": "${repoName}", "branch": "main" },
  "evidenceFiles": ["file1.ts", "hallucinated.ts"]
}
\`\`\`
`;

    const result = await contextBuilder.validateResponse(response);

    // Apenas file1.ts é real; hallucinated.ts deve ser removido
    expect(result.evidence?.sourceType).toBe('fallback_rag');
    expect(result.evidence?.evidenceFiles).toEqual(['file1.ts']);
    expect(result.issues.some((i) => i.includes('NÃO EXISTEM'))).toBe(true);
    expect(result.evidence?.evidenceNotes).toMatch(/1 arquivo\(s\) removido/);
  });

  it('deve marcar fallback_rag como blocked quando TODOS os arquivos alucinados', async () => {
    (repoService.getRepoWithFiles as any).mockResolvedValue(null);
    (gitHubService.verifyFilesExist as any).mockResolvedValue({
      existing: [],
      missing: ['fake1.ts', 'fake2.ts'],
    });

    const response = `
**Análise:** RAG retornou arquivos inexistentes.
**Problema Identificado:** N/A
**Impacto:** Alto
**Recomendação:** Teste
**ROI:** 1:1
**Esforço:** 1 dia
**Prioridade:** Importante

**Evidence Block:**
\`\`\`json
{
  "sourceType": "fallback_rag",
  "repoContext": { "owner": "${owner}", "repo": "${repoName}", "branch": "main" },
  "evidenceFiles": ["fake1.ts", "fake2.ts"]
}
\`\`\`
`;

    const result = await contextBuilder.validateResponse(response);

    expect(result.evidence?.sourceType).toBe('blocked');
    expect(result.evidence?.evidenceFiles).toEqual([]);
    expect(result.evidence?.evidenceNotes).toMatch(/Nenhum arquivo/);
  });
});

describe('Response Contract (Fase 2 / Faixa B)', () => {
  const validContract = `Texto em markdown da análise.\n\n**Response Contract:**\n\`\`\`json\n{ "analysis": "a", "problem": "p", "impact": "i", "recommendation": "r", "roi": "3:1", "effort": "2 dias", "priority": "Importante" }\n\`\`\``;

  it('aceita um Response Contract completo e remove o bloco do texto', () => {
    const result = contextBuilder.validateResponseContract(validContract);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.cleanMessage).toBe('Texto em markdown da análise.');
    expect(result.cleanMessage).not.toContain('Response Contract');
  });

  it('rejeita (erro bloqueante) quando o bloco está ausente', () => {
    const result = contextBuilder.validateResponseContract('Só markdown, sem contrato.');
    expect(result.valid).toBe(false);
    expect(result.issues[0].severity).toBe('error');
    expect(result.issues[0].message).toContain('obrigatório não encontrado');
  });

  it('rejeita priority fora do enum e reporta o campo como erro', () => {
    const bad = `**Response Contract:**\n\`\`\`json\n{ "analysis": "a", "problem": "p", "impact": "i", "recommendation": "r", "roi": "3:1", "effort": "2 dias", "priority": "Urgente" }\n\`\`\``;
    const result = contextBuilder.validateResponseContract(bad);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.message.includes('priority'))).toBe(true);
    expect(result.issues.every((i) => i.severity === 'error')).toBe(true);
  });
});
