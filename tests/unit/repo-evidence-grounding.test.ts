/**
 * P0 de grounding do roundtable — critérios de aceite e regressões da revisão.
 *
 * Contexto: a demanda 10330 foi refinada por um ciclo inteiro sobre a premissa
 * falsa de que `agent_jobs` perdera 669 registros. Nada havia sido apagado.
 *
 * A PRIMEIRA versão destes testes mascarava dois defeitos, e a revisão pegou:
 *  - mockava `data` como STRING, contrato que nunca existiu — o envelope real de
 *    `get_file_content` é `{ path, content, ... }`, e o coletor fazia
 *    `String(data)`, gravando "[object Object]" como evidência;
 *  - o gate aprovava a alegação só porque o ARQUIVO estava no pacote, sem olhar
 *    símbolo nem trecho.
 * Por isso as fixtures aqui usam o envelope REAL e os contraexemplos da revisão.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

const { executeTool } = vi.hoisted(() => ({ executeTool: vi.fn() }));
vi.mock('../../server/services/agent-tools-registry', () => ({ executeTool }));

vi.mock('../../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  collectRepoEvidence,
  demandRequiresRepoInspection,
  formatEvidenceForPrompt,
  SNIPPET_MAX_CHARS,
  __resetLocalRepoCacheForTests,
  type RepoEvidencePackage,
} from '../../server/services/repo-evidence-collector';
import { evaluateFactualClaims } from '../../server/services/factual-claims-gate';
import { buildRoundtablePRDContent } from '../../server/services/ai-squad/roundtable-prd';
import type { Demand } from '@shared/schema';

beforeEach(() => {
  vi.clearAllMocks();
  __resetLocalRepoCacheForTests();
});

/** Repositório DESTE checkout — só ele autoriza a leitura em disco. */
const LOCAL_REPO = (() => {
  const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const match = remoteUrl.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) throw new Error('Remote origin sem owner/repo reconhecível');
  return `${match[1]}/${match[2]}`;
})();

const demand = (overrides: Partial<Demand> = {}): Demand =>
  ({
    id: 1,
    title: 'Demanda',
    description: 'sem citação de código',
    repoFullName: 'owner/repo',
    ...overrides,
  }) as Demand;

/** Envelope REAL de get_file_content (ver tech-lead-tools.ts). */
const toolEnvelope = (filePath: string, content: string) => ({
  ok: true,
  source: 'get_file_content',
  data: {
    path: filePath,
    source: 'indexed',
    language: 'typescript',
    content,
    truncated: false,
    totalLines: content.split('\n').length,
  },
});

/** Pacote sintético, para exercitar o gate sem passar pelo coletor. */
const packageWith = (files: Array<{ file: string; snippet: string }>): RepoEvidencePackage =>
  Object.freeze({
    evidence: Object.freeze(
      files.map((f) =>
        Object.freeze({
          tool: 'local_checkout',
          file: f.file,
          symbols: Object.freeze([...new Set(f.snippet.match(/\b[A-Za-z_$][\w$]{2,}\b/g) ?? [])]),
          snippet: f.snippet,
          verifiedAt: new Date().toISOString(),
        }),
      ),
    ),
    inspectionRequired: true,
    degraded: false,
    reason: null,
  }) as RepoEvidencePackage;

/** Demanda que não pede inspeção: nada coletado, e isso NÃO é degradação. */
const emptyPackage = (): RepoEvidencePackage =>
  Object.freeze({
    evidence: Object.freeze([]),
    inspectionRequired: false,
    degraded: false,
    reason: null,
  }) as RepoEvidencePackage;

describe('REGRESSÃO: envelope real da ferramenta', () => {
  it('extrai data.content e data.path, nunca "[object Object]"', async () => {
    // O arquivo NÃO existe no checkout, então cai na ferramenta.
    executeTool.mockResolvedValue(
      toolEnvelope('server/services/inexistente-xyz.ts', 'export const MIN_ROUNDTABLE_AGENTS = 3;'),
    );

    const pkg = await collectRepoEvidence(
      demand({ description: 'quebra em server/services/inexistente-xyz.ts' }),
    );

    expect(pkg.evidence).toHaveLength(1);
    expect(pkg.evidence[0].snippet).toBe('export const MIN_ROUNDTABLE_AGENTS = 3;');
    expect(pkg.evidence[0].snippet).not.toContain('[object Object]');
    expect(pkg.evidence[0].file).toBe('server/services/inexistente-xyz.ts');
    expect(pkg.evidence[0].symbols).toContain('MIN_ROUNDTABLE_AGENTS');
  });

  it('data sem content utilizável DEGRADA, não vira evidência', async () => {
    executeTool.mockResolvedValue({ ok: true, source: 'get_file_content', data: { path: 'x' } });

    const pkg = await collectRepoEvidence(
      demand({ description: 'ver server/services/inexistente-xyz.ts' }),
    );

    expect(pkg.evidence).toHaveLength(0);
    expect(pkg.degraded).toBe(true);
  });

  it('data como string (envelope irreal) não é aceito', async () => {
    executeTool.mockResolvedValue({ ok: true, source: 'x', data: 'conteúdo solto' });

    const pkg = await collectRepoEvidence(
      demand({ description: 'ver server/services/inexistente-xyz.ts' }),
    );

    expect(pkg.degraded).toBe(true);
    expect(pkg.evidence).toHaveLength(0);
  });
});

describe('REGRESSÃO: os quatro contraexemplos LITERAIS da revisão', () => {
  const pkg = () =>
    packageWith([
      { file: 'server/db.ts', snippet: 'export const db = drizzle(sqliteDb);' },
      { file: 'shared/agent-roles.ts', snippet: 'export const MIN_ROUNDTABLE_AGENTS = 3;' },
    ]);

  // Texto literal reportado na revisão, sem reescrever para uma forma mais
  // estruturada — foi exatamente essa substituição que mascarou os dois casos
  // que ainda passavam.
  const CONTRAEXEMPLOS: Array<[string, string]> = [
    ['agent_jobs perdeu 669 registros', 'agent_jobs perdeu 669 registros'],
    [
      'server/db.ts exporta resolveDatabaseUrl e apaga tudo',
      'Confirmado no código: server/db.ts exporta resolveDatabaseUrl e apaga tudo.',
    ],
    [
      'Confirmação de Causa Raiz... 669 registros',
      'Confirmação de Causa Raiz: a tabela perdeu 669 registros na execução.',
    ],
    [
      'Cadeia de Import Confirmada: server/db.ts apaga tudo',
      'Cadeia de Import Confirmada: server/db.ts apaga tudo.',
    ],
  ];

  it.each(CONTRAEXEMPLOS)('reprova: %s', (_nome, texto) => {
    const gate = evaluateFactualClaims(texto, pkg());
    expect(gate.status).toBe('failed');
    expect(gate.requiresHumanReview).toBe(true);
  });

  it('reprova alegação de verificação com caminho mas SEM símbolo auditável', () => {
    const gate = evaluateFactualClaims('Confirmado no código: server/db.ts apaga tudo.', pkg());
    expect(gate.status).toBe('failed');
    expect(gate.unsupportedClaims[0].reason).toBe('no_auditable_symbol');
  });

  it('reprova símbolo sem crase que não está no trecho', () => {
    const gate = evaluateFactualClaims(
      'Confirmado no código: server/db.ts exporta resolveDatabaseUrl.',
      pkg(),
    );
    expect(gate.status).toBe('failed');
    expect(gate.unsupportedClaims[0].reason).toBe('symbol_not_in_snippet');
  });

  it('reprova caminho fora do pacote de evidência', () => {
    const gate = evaluateFactualClaims(
      'Confirmado no código que server/services/inventado.ts faz o parse.',
      pkg(),
    );
    expect(gate.status).toBe('failed');
    expect(gate.unsupportedClaims[0].reason).toBe('path_not_in_evidence');
  });

  it('APROVA alegação sustentada por arquivo e símbolo presentes', () => {
    const gate = evaluateFactualClaims(
      'Confirmado no código: `MIN_ROUNDTABLE_AGENTS` está em shared/agent-roles.ts.',
      pkg(),
    );
    expect(gate.status).toBe('passed');
    expect(gate.requiresHumanReview).toBe(false);
  });
});

describe('REGRESSÃO: linguagem de produto vs. evidência de código (3ª revisão)', () => {
  const pkg = () =>
    packageWith([{ file: 'server/db.ts', snippet: 'export const db = drizzle(sqliteDb);' }]);

  // Verbo de verificação sem contexto de código é linguagem comum de produto.
  it.each([
    'O usuário deve ter e-mail verificado.',
    'Escopo confirmado pelo usuário.',
    'O cadastro precisa ser confirmado antes do envio.',
  ])('NÃO reprova linguagem de produto: %s', (texto) => {
    expect(evaluateFactualClaims(texto, pkg()).status).toBe('passed');
  });

  // Transição observada vence palavras normativas como critério/SLA.
  it.each([
    'Critério violado: passou de 669 registros para zero.',
    'O SLA caiu de 99 para 80 linhas.',
    'O requisito perdeu 120 registros na última execução.',
  ])('reprova observação de runtime mesmo com palavra normativa: %s', (texto) => {
    const gate = evaluateFactualClaims(texto, pkg());
    expect(gate.status).toBe('failed');
    expect(gate.unsupportedClaims[0].reason).toBe('runtime_claim');
  });

  it('mantém a alegação sobre código reprovando quando há contexto de código', () => {
    const gate = evaluateFactualClaims(
      'Confirmado no código: server/db.ts exporta resolveDatabaseUrl.',
      pkg(),
    );
    expect(gate.status).toBe('failed');
  });
});

/**
 * O gate roda sobre a saída de `buildRoundtablePRDContent` (ai-squad.ts monta
 * `${consolidationText}\n\n${tasksContent}`). O template injeta, em TODA
 * demanda, "Só inclua um número se ele veio ... de evidência verificada do
 * repositório" — verbo + contexto de repositório. Resultado: uma demanda
 * trivial de botão azul, sem uma linha de inspeção de código, saía
 * `failed`/`no_evidence` com `citedSymbol: 'veio'`, e TODO refinamento normal
 * era marcado para revisão humana.
 *
 * Por isso este teste usa o builder REAL: fixture sintética não pegaria.
 */
describe('REGRESSÃO: PRD real de demanda trivial não pode ser reprovado', () => {
  const prdTrivial = () =>
    buildRoundtablePRDContent(
      {
        problema: 'O botao hoje e cinza e some no fundo claro.',
        objetivo: 'Permitir que o usuario troque a cor do botao principal para azul.',
        escopo: 'Adicionar opcao de cor azul no botao primario.',
        criterios_de_aceite: ['O botao aparece azul apos salvar a preferencia'],
        riscos: [],
        dependencias: [],
        divergencias: [],
        consolidacao: 'A mesa concordou com a troca de cor.',
      },
      { demandTitle: 'Botao azul', demandType: 'nova_funcionalidade' },
    );

  it('o boilerplate de integridade numérica não é alegação factual', () => {
    // Guarda o pressuposto: se o template mudar, o teste ainda faz sentido.
    expect(prdTrivial()).toContain('evidência verificada do repositório');

    const gate = evaluateFactualClaims(prdTrivial(), emptyPackage());

    expect(gate.unsupportedClaims).toEqual([]);
    expect(gate.status).toBe('passed');
    expect(gate.requiresHumanReview).toBe(false);
  });

  it('mas uma alegação inventada ENXERTADA no mesmo PRD continua reprovando', () => {
    const gate = evaluateFactualClaims(
      `${prdTrivial()}\n\nConfirmado no código: server/db.ts exporta resolveDatabaseUrl.`,
      packageWith([{ file: 'server/db.ts', snippet: 'export const db = drizzle(sqliteDb);' }]),
    );

    expect(gate.status).toBe('failed');
    expect(gate.unsupportedClaims.map((c) => c.reason)).toContain('symbol_not_in_snippet');
  });
});

/**
 * A regra de transição era POSICIONAL (`… de N`, `de N para M`) e errava nos
 * dois sentidos. Agora é semântica: exige verbo de MUDANÇA DE GRANDEZA. Estas
 * três linhas são as regressões literais da 3ª revisão.
 */
describe('REGRESSÃO: transição de runtime é verbo de mudança + numeral (3ª revisão)', () => {
  const pkg = () =>
    packageWith([{ file: 'server/db.ts', snippet: 'export const db = drizzle(sqliteDb);' }]);

  it.each([
    // sem "de N" — a forma antiga exigia o `de`
    'O SLA caiu para 80 linhas.',
    // numeral não colado no verbo
    'Critério violado: perdeu os 120 registros.',
    // grandeza com unidade muda de valor, mesmo sem verbo
    'Critério violado: de 669 registros para zero.',
    // zeragem é estado medido por si
    'A tabela zerou.',
  ])('reprova observação de runtime: %s', (texto) => {
    const gate = evaluateFactualClaims(texto, pkg());
    expect(gate.status).toBe('failed');
    expect(gate.unsupportedClaims[0].reason).toBe('runtime_claim');
  });

  it.each([
    // "migrar" prescreve, não mede — a forma "de N para M" casava e reprovava
    'Migrar o schema de 1 para 2.',
    // cópulas genéricas não podem transformar todo número em runtime
    'A tarefa foi estimada em 3 pontos.',
    'O layout ficou com 3 colunas.',
  ])('NÃO reprova prescrição nem número solto: %s', (texto) => {
    expect(evaluateFactualClaims(texto, pkg()).status).toBe('passed');
  });

  it('o "se" reflexivo não abre buraco na isenção de instrução de autoria', () => {
    // "se conecta" é pronome reflexivo, não condicional: continua sendo alegação.
    const gate = evaluateFactualClaims(
      'O módulo se conecta ao banco conforme verificado no repositório.',
      pkg(),
    );
    expect(gate.status).toBe('failed');
  });
});

describe('REGRESSÃO: contenção contra symlink no checkout local', () => {
  it('rejeita arquivo que é symlink para fora do checkout', async () => {
    const fs = await import('node:fs');
    const link = 'server/__leak-probe.ts';
    // Aponta para fora da raiz do repositório.
    fs.symlinkSync('/etc/hosts', link);
    try {
      executeTool.mockResolvedValue({ ok: false, error: 'not found' });

      const pkg = await collectRepoEvidence(
        demand({ repoFullName: LOCAL_REPO, description: `investigar ${link}` }),
      );

      // Nada do alvo do link pode virar evidência.
      expect(pkg.evidence).toHaveLength(0);
      expect(pkg.degraded).toBe(true);
    } finally {
      fs.unlinkSync(link);
    }
  });

  /**
   * Este teste olha o MECANISMO, não só o resultado.
   *
   * A versão anterior checava apenas `snippet.length <= 4000` — e a
   * implementação antiga, que fazia `readFileSync` do arquivo inteiro e depois
   * `slice(0, 4000)`, passava exatamente igual. Ou seja: não provava nada sobre
   * o que foi lido do disco.
   */
  it('lê no máximo SNIPPET_MAX_CHARS do disco — não carrega o arquivo inteiro', async () => {
    const fs = (await import('node:fs')).default;
    const readFileSync = vi.spyOn(fs, 'readFileSync');
    const readSync = vi.spyOn(fs, 'readSync');

    try {
      const pkg = await collectRepoEvidence(
        demand({ repoFullName: LOCAL_REPO, description: 'ver shared/schema.ts' }),
      );

      expect(pkg.evidence).toHaveLength(1);

      // Nenhuma leitura integral do alvo.
      const alvoLidoInteiro = readFileSync.mock.calls.some((call) =>
        String(call[0]).includes('schema.ts'),
      );
      expect(alvoLidoInteiro).toBe(false);

      // `readSync(fd, buffer, offset, length, position)` — o 4º argumento é o
      // teto de bytes, e tem de ser o teto REAL do módulo.
      expect(readSync).toHaveBeenCalledTimes(1);
      const [, buffer, , length] = readSync.mock.calls[0];
      expect(length).toBe(SNIPPET_MAX_CHARS);
      expect((buffer as Buffer).length).toBe(SNIPPET_MAX_CHARS);

      // shared/schema.ts é muito maior que o teto: o snippet sai truncado.
      expect(pkg.evidence[0].snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    } finally {
      readFileSync.mockRestore();
      readSync.mockRestore();
    }
  });
});

describe('REGRESSÃO: requisito normativo não é observação de runtime', () => {
  const pkg = () =>
    packageWith([{ file: 'server/db.ts', snippet: 'export const db = drizzle(sqliteDb);' }]);

  it.each([
    'Critério de aceite: manter o arquivo abaixo de 500 linhas.',
    'O endpoint deve suportar 100 chamadas por minuto.',
    'Requisito: no máximo 2000 tokens por prompt.',
  ])('não reprova requisito: %s', (texto) => {
    const gate = evaluateFactualClaims(texto, pkg());
    expect(gate.status).toBe('passed');
  });

  it('mas continua reprovando observação de estado medido', () => {
    const gate = evaluateFactualClaims('A tabela passou de 669 registros para zero.', pkg());
    expect(gate.status).toBe('failed');
    expect(gate.unsupportedClaims[0].reason).toBe('runtime_claim');
  });
});

describe('REGRESSÃO: o PRD sanitizado com alegações não sustentadas não pode passar', () => {
  it('reprova a fixture pública que preserva o caso de grounding', async () => {
    const fs = await import('node:fs');
    const prd = fs.readFileSync(
      'tests/fixtures/grounding-unsupported-runtime-claims-prd.md',
      'utf8',
    );

    const gate = evaluateFactualClaims(
      prd,
      packageWith([{ file: 'server/db.ts', snippet: 'export const db = drizzle(sqliteDb);' }]),
    );

    expect(gate.status).toBe('failed');
    expect(gate.requiresHumanReview).toBe(true);
  });
});

describe('AC1 — demanda que exige inspeção produz evidência verificável', () => {
  it('lê do checkout local sem depender de credencial de rede', async () => {
    const pkg = await collectRepoEvidence(
      demand({ repoFullName: LOCAL_REPO, description: 'quebra em shared/agent-roles.ts' }),
    );

    // Arquivo existe no repo: nem chega a chamar a ferramenta (401 no ambiente).
    expect(executeTool).not.toHaveBeenCalled();
    expect(pkg.degraded).toBe(false);
    expect(pkg.evidence[0].tool).toBe('local_checkout');
    expect(pkg.evidence[0].symbols).toContain('MIN_ROUNDTABLE_AGENTS');
  });

  it('o pacote entregue à mesa é imutável', async () => {
    const pkg = await collectRepoEvidence(
      demand({ repoFullName: LOCAL_REPO, description: 'ver shared/agent-roles.ts' }),
    );
    expect(Object.isFrozen(pkg)).toBe(true);
    expect(Object.isFrozen(pkg.evidence)).toBe(true);
    expect(Object.isFrozen(pkg.evidence[0])).toBe(true);
  });
});

describe('REGRESSÃO: checkout local não vaza para outro repositório', () => {
  it('demanda de outro repo NÃO recebe arquivo do checkout local', async () => {
    executeTool.mockResolvedValue({ ok: false, error: 'not found' });

    const pkg = await collectRepoEvidence(
      demand({
        repoFullName: 'empresa/repositorio-totalmente-diferente',
        description: 'quebra em shared/agent-roles.ts',
      }),
    );

    // O arquivo existe NESTE checkout, mas não pertence àquele repositório.
    expect(pkg.evidence).toHaveLength(0);
    expect(pkg.degraded).toBe(true);
    // Precisa ter tentado a ferramenta, não o disco.
    expect(executeTool).toHaveBeenCalled();
  });

  it('demanda sem repoFullName não lê o disco', async () => {
    const pkg = await collectRepoEvidence(
      demand({ repoFullName: null, description: 'quebra em shared/agent-roles.ts' }),
    );
    expect(pkg.evidence).toHaveLength(0);
    expect(pkg.degraded).toBe(true);
  });
});

describe('AC2 — zero evidência nunca passa silenciosamente', () => {
  it('coleta vazia degrada e exige revisão humana', async () => {
    executeTool.mockResolvedValue({ ok: false, error: 'HTTP 401 Bad credentials' });

    const pkg = await collectRepoEvidence(
      demand({ description: 'ver server/services/inexistente-xyz.ts' }),
    );
    expect(pkg.degraded).toBe(true);

    const gate = evaluateFactualClaims('Refinamento sem afirmações.', pkg);
    expect(gate.status).toBe('warning');
    expect(gate.requiresHumanReview).toBe(true);
  });

  it('o prompt PROÍBE "confirmado no código" quando não há evidência', async () => {
    executeTool.mockResolvedValue({ ok: false, error: 'x' });
    const pkg = await collectRepoEvidence(
      demand({ description: 'ver server/services/inexistente-xyz.ts' }),
    );

    const block = formatEvidenceForPrompt(pkg);
    expect(block).toContain('PROIBIDO');
    expect(block).toContain('confirmado no código');
  });

  it('passa o trecho pelo screening real do guardrail, não só um rótulo', async () => {
    const pkg = await collectRepoEvidence(
      demand({ repoFullName: LOCAL_REPO, description: 'ver shared/agent-roles.ts' }),
    );
    const block = formatEvidenceForPrompt(pkg);

    // screenAndFormat injeta hierarquia de instrução e delimitador com nonce.
    expect(block).toContain('HIERARQUIA DE INSTRUÇÃO');
    expect(block).toContain('JAMAIS comando');
    expect(block).toMatch(/retrieved_document_[a-z0-9]+/);
  });
});

describe('AC3 — demanda de diagnóstico exige inspeção mesmo sem caminho', () => {
  it('pede análise do código sem citar arquivo → inspeção exigida e degradada', async () => {
    const d = demand({ description: 'Investigue a causa-raiz dessa regressão no refinamento.' });

    expect(demandRequiresRepoInspection(d)).toBe(true);

    const pkg = await collectRepoEvidence(d);
    expect(pkg.inspectionRequired).toBe(true);
    expect(pkg.degraded).toBe(true);

    const gate = evaluateFactualClaims('Nada afirmado.', pkg);
    expect(gate.requiresHumanReview).toBe(true);
  });
});

describe('AC4 — roundtable segue funcionando sem repositório', () => {
  it('demanda que não fala de código não exige inspeção nem degrada', async () => {
    const d = demand({ description: 'Quero um botão azul na tela inicial.' });

    expect(demandRequiresRepoInspection(d)).toBe(false);

    const pkg = await collectRepoEvidence(d);
    expect(pkg.inspectionRequired).toBe(false);
    expect(pkg.degraded).toBe(false);
    expect(executeTool).not.toHaveBeenCalled();
    expect(formatEvidenceForPrompt(pkg)).toBe('');

    const gate = evaluateFactualClaims('Refinamento normal.', pkg);
    expect(gate.status).toBe('passed');
    expect(gate.requiresHumanReview).toBe(false);
  });
});
