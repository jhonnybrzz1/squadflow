import { describe, expect, it, vi, beforeEach } from 'vitest';

const refinementMock = vi.hoisted(() => ({
  retrieveHybrid: vi.fn(),
  buildContext: vi.fn(),
}));

const domainMock = vi.hoisted(() => ({
  buildContext: vi.fn(),
}));

vi.mock('../../server/services/refinement-rag', () => ({
  refinementRAGService: refinementMock,
}));

vi.mock('../../server/services/domain-knowledge-rag', () => ({
  domainKnowledgeRAGService: domainMock,
}));

import { ragRetrieval } from '../../server/services/rag-retrieval';

describe('ragRetrieval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retorna sem_contexto_repo=true quando nenhum repositório é informado', async () => {
    const result = await ragRetrieval({ query: 'algo' });

    expect(result.semContextoRepo).toBe(true);
    expect(result.repoChunkCount).toBe(0);
    expect(refinementMock.retrieveHybrid).not.toHaveBeenCalled();
  });

  it('consulta o repositório e retorna sem_contexto_repo=false quando há chunks', async () => {
    refinementMock.retrieveHybrid.mockResolvedValue([{ sourceKey: 'a', score: 0.9 }]);
    refinementMock.buildContext.mockResolvedValue('CONTEXTO REPO FORMATADO');

    const result = await ragRetrieval({ query: 'algo', repoFullName: 'org/repo' });

    expect(refinementMock.retrieveHybrid).toHaveBeenCalledWith('algo', 4, {
      repoFullName: 'org/repo',
    });
    expect(result.semContextoRepo).toBe(false);
    expect(result.repoChunkCount).toBe(1);
    expect(result.contextText).toContain('CONTEXTO REPO FORMATADO');
  });

  it('sem_contexto_repo=true quando a busca no repo retorna vazio', async () => {
    refinementMock.retrieveHybrid.mockResolvedValue([]);

    const result = await ragRetrieval({ query: 'algo', repoFullName: 'org/repo' });

    expect(result.semContextoRepo).toBe(true);
    expect(refinementMock.buildContext).not.toHaveBeenCalled();
  });

  it('agrega chunks de múltiplos repositórios (primário + additionalRepos)', async () => {
    refinementMock.retrieveHybrid
      .mockResolvedValueOnce([{ sourceKey: 'a' }])
      .mockResolvedValueOnce([{ sourceKey: 'b' }]);
    refinementMock.buildContext.mockResolvedValue('CTX');

    const result = await ragRetrieval({
      query: 'algo',
      repoFullName: 'org/repo1',
      additionalRepos: ['org/repo2'],
    });

    expect(refinementMock.retrieveHybrid).toHaveBeenCalledTimes(2);
    expect(result.repoChunkCount).toBe(2);
    expect(result.semContextoRepo).toBe(false);
  });

  it('consulta a base de domínio especializado quando domain=legaltech_lgpd', async () => {
    domainMock.buildContext.mockReturnValue('CORPUS LEGALTECH');

    const result = await ragRetrieval({ query: 'algo', domain: 'legaltech_lgpd' });

    expect(domainMock.buildContext).toHaveBeenCalledWith('legaltech_lgpd', 'algo');
    expect(result.contextText).toContain('CORPUS LEGALTECH');
  });

  it('não consulta domain knowledge para domínio padrão', async () => {
    const result = await ragRetrieval({ query: 'algo', domain: 'padrao' });

    expect(domainMock.buildContext).not.toHaveBeenCalled();
    expect(result.contextText).not.toBe('');
  });
});

/**
 * Auditoria 2026-08-01 (A14) — `require is not defined` na reformulação.
 *
 * `getDomainNames()` usava `require('./domain-config')` num projeto ESM
 * (`"type": "module"`), com o comentário "lazy import to avoid circular
 * dependency". Duas coisas erradas: `require` não existe em ESM, e não havia
 * ciclo — `domain-config` importa só node:fs/node:path/zod/logger/url, e este
 * módulo já o importava estaticamente, o que anularia o lazy load de todo modo.
 *
 * O caminho só é alcançado com um domínio DESCONHECIDO. Um POST de payload
 * mínimo em /api/demands/reformulate retorna 200 mesmo com o bug presente —
 * por isso o teste força o ramo que realmente quebrava.
 */
describe('domínio desconhecido (A14): lista os domínios sem estourar em ESM', () => {
  it('não lança ReferenceError e devolve a lista de domínios configurados', async () => {
    const result = await ragRetrieval({ query: 'algo', domain: 'dominio_que_nao_existe' });

    expect(result.domainInvalid).toBe(true);
    expect(result.contextText).toContain('Domínio desconhecido: dominio_que_nao_existe');
    expect(result.contextText).toContain('Domínios configurados:');
  });

  it('a lista devolvida é exatamente a de getDomains(), sem perda na troca de import', async () => {
    const { getDomains } = await import('../../server/services/domain-config');
    const esperados = getDomains().map((d) => d.name);

    const result = await ragRetrieval({ query: 'algo', domain: '__invalido__' });

    // Critério de aceite do fix: o array de domínios tem que ser idêntico ao de
    // antes da troca de `require` por import estático.
    expect(esperados.length).toBeGreaterThan(0);
    for (const nome of esperados) {
      expect(result.contextText).toContain(nome);
    }
  });

  it('não consulta o RAG de domínio, mas ainda reporta as estatísticas do repo', async () => {
    refinementMock.retrieveHybrid.mockResolvedValue([]);

    const result = await ragRetrieval({
      query: 'algo',
      domain: '__invalido__',
      repoFullName: 'org/repo',
    });

    // O RAG de domínio fica depois do early return — não é consultado.
    expect(domainMock.buildContext).not.toHaveBeenCalled();

    // Já o RAG do REPO roda antes da validação, e isso é intencional: a
    // resposta de domínio inválido devolve `repoChunkCount`/`semContextoRepo`
    // reais, não zerados. Custa uma busca que será descartada, mas o contrato
    // depende desses números.
    expect(refinementMock.retrieveHybrid).toHaveBeenCalledTimes(1);
    expect(result.repoChunkCount).toBe(0);
    expect(result.semContextoRepo).toBe(true);
  });
});
