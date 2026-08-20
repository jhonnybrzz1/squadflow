/**
 * Tests for:
 * 1. resolveDemandRepoFullName (server/utils/repo-context.ts)
 * 2. repoFullName injection into agent tools userPrompt (server/services/ai-squad.ts)
 *
 * The injection fix ensures that tech_lead / qa tools (search_codebase,
 * get_file_content, etc.) receive the correct "owner/repo" string from the
 * LLM instead of having the model guess or hallucinate it.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveDemandRepoFullName,
  extractRepoFullNameFromText,
  buildRepoFullName,
  parseAdditionalRepos,
  formatAdditionalReposBlock,
} from '../../server/utils/repo-context';

// -------------------------------------------------------
// buildRepoFullName
// -------------------------------------------------------
describe('buildRepoFullName', () => {
  it('retorna owner/name quando ambos são válidos', () => {
    expect(buildRepoFullName('acme', 'my-app')).toBe('acme/my-app');
  });

  it('retorna null quando owner é null', () => {
    expect(buildRepoFullName(null, 'repo')).toBeNull();
  });

  it('retorna null quando name é undefined', () => {
    expect(buildRepoFullName('owner', undefined)).toBeNull();
  });

  it('retorna null para strings vazias', () => {
    expect(buildRepoFullName('', 'repo')).toBeNull();
    expect(buildRepoFullName('owner', '')).toBeNull();
  });

  it('retorna null para caracteres inválidos no nome do repo', () => {
    expect(buildRepoFullName('owner', 'repo with spaces')).toBeNull();
  });

  it('aceita hífens, underscores e pontos no nome', () => {
    expect(buildRepoFullName('my-org', 'my_repo.js')).toBe('my-org/my_repo.js');
  });
});

// -------------------------------------------------------
// extractRepoFullNameFromText
// -------------------------------------------------------
describe('extractRepoFullNameFromText', () => {
  it('extrai repo do padrão "Repositório: owner/repo"', () => {
    expect(extractRepoFullNameFromText('Repositório: acme/app')).toBe('acme/app');
  });

  it('extrai repo do padrão legado "Repositorio: owner/repo" (sem acento)', () => {
    expect(extractRepoFullNameFromText('Repositorio: acme/app-v2')).toBe('acme/app-v2');
  });

  it('extrai repo quando há texto ao redor', () => {
    const desc = 'Demanda de feature. Repositório: example-org/aichatflow. Implementar cache.';
    expect(extractRepoFullNameFromText(desc)).toBe('example-org/aichatflow');
  });

  it('retorna null quando não há padrão Repositório', () => {
    expect(extractRepoFullNameFromText('Implementar funcionalidade de login')).toBeNull();
  });

  it('retorna null para texto null ou undefined', () => {
    expect(extractRepoFullNameFromText(null)).toBeNull();
    expect(extractRepoFullNameFromText(undefined)).toBeNull();
    expect(extractRepoFullNameFromText('')).toBeNull();
  });

  it('retorna null quando repo extraído não é válido', () => {
    // Padrão encontrado mas valor inválido
    expect(extractRepoFullNameFromText('Repositório: não/é válido aqui')).toBeNull();
  });
});

// -------------------------------------------------------
// resolveDemandRepoFullName
// -------------------------------------------------------
describe('resolveDemandRepoFullName', () => {
  it('prefere repoFullName explícito ao campo description', () => {
    const demand = {
      repoFullName: 'owner/explicit-repo',
      description: 'Repositório: owner/from-description',
    };
    expect(resolveDemandRepoFullName(demand)).toBe('owner/explicit-repo');
  });

  it('cai para description quando repoFullName é null', () => {
    const demand = {
      repoFullName: null,
      description: 'Repositório: owner/from-description',
    };
    expect(resolveDemandRepoFullName(demand)).toBe('owner/from-description');
  });

  it('cai para description quando repoFullName é undefined', () => {
    const demand = {
      description: 'Corrigir bug. Repositório: org/my-service. Urgente.',
    };
    expect(resolveDemandRepoFullName(demand)).toBe('org/my-service');
  });

  it('retorna null quando repoFullName é inválido e description não tem repo', () => {
    const demand = {
      repoFullName: 'invalido-sem-barra',
      description: 'Sem repositório na descrição',
    };
    expect(resolveDemandRepoFullName(demand)).toBeNull();
  });

  it('retorna null quando repoFullName é string vazia e description não tem repo', () => {
    const demand = {
      repoFullName: '   ',
      description: 'Implementar login',
    };
    expect(resolveDemandRepoFullName(demand)).toBeNull();
  });

  it('retorna null quando ambos são null/vazio', () => {
    const demand = { repoFullName: null, description: null };
    expect(resolveDemandRepoFullName(demand)).toBeNull();
  });

  it('ignora repoFullName com espaços (trim + validação)', () => {
    const demand = {
      repoFullName: '  owner/repo  ',
      description: null,
    };
    // trim é aplicado antes da validação
    expect(resolveDemandRepoFullName(demand)).toBe('owner/repo');
  });
});

// -------------------------------------------------------
// Lógica de injeção no userPrompt (comportamento esperado em ai-squad.ts)
// -------------------------------------------------------
describe('repoFullName injection into userPrompt (comportamento esperado)', () => {
  /**
   * Estes testes verificam a lógica de construção do userPromptWithRepo
   * que foi adicionada em ai-squad.ts para garantir que o LLM receba
   * o repoFullName correto ao chamar tools como search_codebase.
   *
   * A função auxiliar abaixo espelha exatamente o código adicionado:
   *   const userPromptWithRepo = repoFullName
   *     ? `${userPrompt}\n\n--- REPOSITÓRIO DA DEMANDA ---\nrepoFullName: ${repoFullName}\n...`
   *     : userPrompt;
   */
  function buildUserPromptWithRepo(userPrompt: string, repoFullName: string | null): string {
    return repoFullName
      ? `${userPrompt}\n\n--- REPOSITÓRIO DA DEMANDA ---\nrepoFullName: ${repoFullName}\nUse este valor como parâmetro "repoFullName" em todas as tool calls que exigirem o repositório.`
      : userPrompt;
  }

  it('adiciona seção REPOSITÓRIO DA DEMANDA quando repoFullName está disponível', () => {
    const base = 'Analise a demanda: corrigir bug de autenticação';
    const result = buildUserPromptWithRepo(base, 'acme/my-service');

    expect(result).toContain('--- REPOSITÓRIO DA DEMANDA ---');
    expect(result).toContain('repoFullName: acme/my-service');
    expect(result).toContain(base);
  });

  it('retorna userPrompt original quando repoFullName é null', () => {
    const base = 'Analise a demanda: corrigir bug';
    const result = buildUserPromptWithRepo(base, null);

    expect(result).toBe(base);
    expect(result).not.toContain('REPOSITÓRIO DA DEMANDA');
  });

  it('o repoFullName injetado é o primeiro token da linha (LLM pode fazer split trivial)', () => {
    const result = buildUserPromptWithRepo('analyze this', 'org/repo');
    const repoLine = result.split('\n').find((line) => line.startsWith('repoFullName:'));

    expect(repoLine).toBe('repoFullName: org/repo');
  });

  it('funciona com demand que tem repoFullName explícito', () => {
    const demand = { repoFullName: 'dev/chatflow', description: 'Bug no login' };
    const resolvedRepo = resolveDemandRepoFullName(demand);
    const prompt = buildUserPromptWithRepo('Analise:', resolvedRepo);

    expect(prompt).toContain('repoFullName: dev/chatflow');
  });

  it('funciona com demand que tem repoFullName apenas na description (legado)', () => {
    const demand = {
      repoFullName: null,
      description: 'Repositório: legacy-org/old-app. Corrigir timeout.',
    };
    const resolvedRepo = resolveDemandRepoFullName(demand);
    const prompt = buildUserPromptWithRepo('Analise:', resolvedRepo);

    expect(prompt).toContain('repoFullName: legacy-org/old-app');
  });
});

// -------------------------------------------------------
// parseAdditionalRepos / formatAdditionalReposBlock
//
// Regressão: o form multi-repo do frontend (demand-form.tsx) envia
// `additionalRepos` como JSON stringificado, mas as rotas de criação de
// demanda (demands.ts x2, cognitive.ts) nunca liam esse campo — qualquer
// repo além do primeiro era descartado silenciosamente na descrição
// persistida. Achado de auditoria 2026-07-21.
// -------------------------------------------------------
describe('parseAdditionalRepos', () => {
  it('parseia um JSON array válido de owner/name', () => {
    expect(parseAdditionalRepos(JSON.stringify(['acme/api', 'acme/worker']))).toEqual([
      'acme/api',
      'acme/worker',
    ]);
  });

  it('filtra entradas que não têm a forma owner/name', () => {
    expect(parseAdditionalRepos(JSON.stringify(['acme/api', 'not-a-repo', '']))).toEqual([
      'acme/api',
    ]);
  });

  it('retorna [] para undefined/null/string vazia', () => {
    expect(parseAdditionalRepos(undefined)).toEqual([]);
    expect(parseAdditionalRepos(null)).toEqual([]);
    expect(parseAdditionalRepos('')).toEqual([]);
  });

  it('retorna [] para JSON inválido (nunca lança)', () => {
    expect(parseAdditionalRepos('{not valid json')).toEqual([]);
  });

  it('retorna [] quando o JSON parseado não é um array', () => {
    expect(parseAdditionalRepos(JSON.stringify({ repo: 'acme/api' }))).toEqual([]);
  });

  it('aceita um array já parseado (não-string)', () => {
    expect(parseAdditionalRepos(['acme/api'])).toEqual(['acme/api']);
  });
});

describe('formatAdditionalReposBlock', () => {
  it('retorna string vazia para lista vazia', () => {
    expect(formatAdditionalReposBlock([])).toBe('');
  });

  it('formata múltiplos repos em bullet list', () => {
    const block = formatAdditionalReposBlock(['acme/api', 'acme/worker']);
    expect(block).toContain('acme/api');
    expect(block).toContain('acme/worker');
    expect(block).toContain('Repositórios adicionais:');
  });
});
