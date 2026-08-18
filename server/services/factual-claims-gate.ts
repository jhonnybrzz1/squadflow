/**
 * Gate factual do roundtable: uma afirmação de verificação ("confirmado no
 * código") só passa se a evidência coletada REALMENTE a sustentar.
 *
 * Motivação concreta: na demanda 10330 a mesa refinou por um ciclo inteiro sobre
 * a premissa falsa de que `agent_jobs` tinha perdido 669 registros — nada havia
 * sido apagado. Nenhum agente inspecionou o repositório e nenhum gate reprovou.
 *
 * A primeira versão deste gate era fraca demais: aceitava a alegação se o
 * ARQUIVO citado pertencesse ao pacote, sem olhar símbolo nem trecho. Com isso,
 * "confirmado no código: server/db.ts perdeu 669 registros" passava, e símbolo
 * inexistente em arquivo real também. Agora:
 *
 *  - caminho citado precisa estar na evidência;
 *  - símbolo citado precisa aparecer no TRECHO daquele arquivo;
 *  - afirmação sobre estado de RUNTIME (contagens, "N registros", "passou de X
 *    para Y") não é verificável por conteúdo de arquivo e exige evidência
 *    tipada própria — na falta dela, revisão humana.
 *
 * Complementa `groundedness-validator` (que avalia o DOCUMENTO gerado, depois do
 * fato) checando as afirmações contra evidência real de repositório.
 */
import type { EvidenceGateStatus, RepoEvidencePackage } from './repo-evidence-collector';

export interface FactualClaim {
  /** Trecho que contém a afirmação de verificação. */
  readonly claim: string;
  /** Por que a afirmação não se sustenta. */
  readonly reason:
    | 'path_not_in_evidence'
    | 'symbol_not_in_snippet'
    | 'runtime_claim'
    | 'no_auditable_symbol'
    | 'no_evidence';
  readonly citedPath: string | null;
  readonly citedSymbol: string | null;
}

export interface FactualGateResult {
  readonly status: EvidenceGateStatus;
  readonly requiresHumanReview: boolean;
  readonly unsupportedClaims: readonly FactualClaim[];
  readonly reason: string | null;
}

/**
 * Verbo de verificação. Sozinho NÃO basta: "o usuário deve ter e-mail
 * verificado" e "escopo confirmado pelo usuário" são linguagem comum de produto,
 * e o gate reprovava ambos como se fossem alegação sobre o código.
 */
const VERIFICATION_VERB = /(confirmad[oa]s?|verificad[oa]s?|comprovad[oa]s?|checad[oa]s?)\b/i;

/**
 * Contexto que transforma o verbo em alegação sobre o CÓDIGO. Sem um destes
 * (ou sem caminho/símbolo citado), a frase é sobre o domínio, não sobre o repo.
 */
const CODE_CONTEXT =
  /\b(c[óo]digo|reposit[óo]rio|repo|arquivo|s[íi]mbolo|import|implementa[çc][ãa]o|fun[çc][ãa]o|classe|m[óo]dulo|schema|migration|endpoint|servi[çc]o|linha \d|commit|branch)\b/i;

/** Expressões que já são, por si, alegação de verificação sobre o código. */
const EXPLICIT_CODE_CLAIM =
  /(conforme o c[óo]digo|o c[óo]digo (?:mostra|confirma|comprova)|cadeia de import)/i;

/**
 * INSTRUÇÃO de autoria não é asserção.
 *
 * O template de PRD injeta, em TODA demanda: "Só inclua um número se ele veio
 * (a) do input do usuário, (b) de evidência verificada do repositório...".
 * Verbo (`verificada`) + contexto (`repositório`) casavam, e o gate reprovava
 * 100% dos PRDs — inclusive o de uma demanda trivial de botão azul, sem
 * inspeção de código nenhuma. É regra sobre o que ESCREVER, não alegação de que
 * algo foi verificado.
 *
 * Deliberadamente estreito: só imperativo de autoria ("só inclua", "nunca
 * invente", "é proibido afirmar"). Um `se` solto NÃO serve — em português o
 * `se` reflexivo ("o módulo se conecta ao banco") apareceria em alegação real e
 * abriria falso-negativo.
 */
const AUTHORING_INSTRUCTION =
  /\b(?:s[óo]|apenas|somente|nunca|jamais|sempre)\s+(?:inclua|afirme|use|cite|escreva|calcule|invente|preencha|assuma|considere|declare)\b|\b[ée]\s+proibido\b|\bn[ãa]o\s+(?:afirme|invente|use|cite|escreva|declare)\b/i;

const PATH_PATTERN = /\b(?:server|client|shared|scripts|config|tests)\/[\w\-./]+\.\w{2,4}\b/;

/**
 * Afirmação sobre estado de runtime: contagem de registros/linhas, transição
 * numérica ("de 669 para zero"), percentuais de execução. Conteúdo de arquivo
 * nunca sustenta isso — foi exatamente a premissa falsa da 10330.
 */
const RUNTIME_UNIT = /(?:registros?|linhas?|rows?|chamadas?|tokens?)/i;
const RUNTIME_CLAIM_PATTERN = new RegExp(
  `\\d[\\d.,]*\\s*${RUNTIME_UNIT.source}|\\bzerad[oa]s?\\b`,
  'i',
);

/**
 * Verbo que relata MUDANÇA DE GRANDEZA já ocorrida. Só pretérito/observacional:
 * `manter`, `suportar`, `migrar` prescrevem, não medem.
 *
 * `foi`/`ficou`/`está` ficaram DE FORA de propósito — são cópulas genéricas
 * ("a tarefa foi estimada em 3 pontos", "o layout ficou com 3 colunas") e
 * transformariam qualquer frase com número em alegação de runtime.
 */
const CHANGE_VERB =
  /\b(?:passou|caiu|subiu|perdeu|ganhou|reduziu|aumentou|baixou|cresceu|despencou|saltou|dobrou|triplicou|regrediu|degradou)\b/i;

/** Numeral, ou as palavras que fazem as vezes de numeral numa transição. */
const QUANTITY = /(?:\d|\bzero\b|\bnenhum\b|\bnada\b)/i;

/**
 * Transição OBSERVADA — verbo de mudança com um numeral por perto, em QUALQUER
 * arranjo, mais o caso especial de zeragem.
 *
 * A versão anterior codificava duas FORMAS estreitas (`… de N` e `de N para M`)
 * e errava nos dois sentidos:
 *
 *   "O SLA caiu para 80 linhas."            → passava (sem `de N`)
 *   "Critério violado: perdeu os 120 …"     → passava (`perdeu` sem numeral colado)
 *   "Migrar o schema de 1 para 2."          → reprovava (forma casava, mas é prescrição)
 *
 * Agora a regra é semântica, não posicional: exige verbo de mudança. Por isso
 * "migrar de 1 para 2" volta a passar — migrar não mede nada.
 *
 * Vence o atalho normativo: "passou de 669 registros para zero" e "o SLA caiu
 * de 99 para 80 linhas" são estado medido mesmo carregando `critério` e `SLA`.
 */
const OBSERVED_TRANSITION = new RegExp(
  [
    // verbo de mudança com numeral por perto
    `${CHANGE_VERB.source}.{0,40}?${QUANTITY.source}`,
    // "de 669 registros para zero" — grandeza COM unidade medível muda de valor;
    // é observação mesmo sem verbo. A unidade é obrigatória, senão "migrar o
    // schema de 1 para 2" voltaria a ser reprovado.
    `\\bde\\s+[\\d.,]+\\s*${RUNTIME_UNIT.source}\\s+para\\b`,
    // zeragem é, por si, estado medido
    `\\bzer(?:ou|ad[oa]s?)\\b`,
  ].join('|'),
  'i',
);

/**
 * Requisito NORMATIVO não é observação de runtime.
 *
 * "manter o arquivo abaixo de 500 linhas" e "deve suportar 100 chamadas" são
 * critérios de aceite — prescrevem o futuro, não afirmam um estado medido. A
 * primeira versão reprovava ambos como `runtime_claim`, um falso positivo que
 * penalizava requisito legítimo.
 */
const NORMATIVE_PATTERN =
  /\b(dev[ea]m?|precisa|necess[áa]rio|requisito|crit[ée]rio|m[áa]ximo|m[íi]nimo|no m[áa]ximo|no m[íi]nimo|abaixo de|acima de|at[ée]\s+\d|n[ãa]o (?:exceder|ultrapassar)|limite|manter|garantir|suportar|target|SLA|or[çc]amento)\b/i;

/** Símbolo citado: em crase, com parênteses, ou "cara de código" no texto. */
const BACKTICK_SYMBOL = /`([A-Za-z_$][\w$.]{2,})`/;
const CALL_SYMBOL = /\b([A-Za-z_$][\w$]{2,})\s*\(/;
/**
 * camelCase, PascalCase, snake_case ou SCREAMING_CASE soltos na frase. Sem isto,
 * "server/db.ts exporta resolveDatabaseUrl" não tinha símbolo detectado e o gate
 * aprovava só porque o CAMINHO existia — dois dos contraexemplos da revisão.
 */
const BARE_SYMBOL =
  /\b(?:[a-z]+[A-Z][\w$]*|[A-Z][a-z]+[A-Z][\w$]*|[a-z]+_[a-z_]+|[A-Z]{2,}_[A-Z_]+)\b/;

/**
 * Frase que contém o marcador.
 *
 * O corte exige espaço/quebra depois da pontuação: partir em todo `.` quebrava
 * `server/services/x.ts` no ponto da extensão e o caminho citado sumia do
 * recorte, fazendo o gate aprovar alegação inventada.
 */
function auditableSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|[\n\r]+|\\n/)
    .map((s) => s.trim())
    .filter((s) => {
      if (s.length === 0) return false;
      const path = s.match(PATH_PATTERN)?.[0] ?? null;
      // Alegação de verificação SOBRE CÓDIGO, ou observação de estado medido —
      // o PRD da 10330 afirmava "passou de 669 registros para zero" como fato,
      // sem marcador nenhum, e por isso escapava.
      return isCodeVerificationClaim(s, path) || isRuntimeObservation(s);
    });
}

/**
 * A frase alega verificação SOBRE O CÓDIGO? Verbo isolado não basta — precisa de
 * contexto de código, de um caminho citado ou de um símbolo em crase.
 */
function isCodeVerificationClaim(sentence: string, citedPath: string | null): boolean {
  // Ancorada num artefato concreto (caminho, símbolo em crase, "conforme o
  // código"), a frase é asserção mesmo em forma imperativa. Sem âncora, um
  // imperativo de autoria é regra de escrita e não alega verificação nenhuma.
  const anchoredToArtifact =
    citedPath !== null || BACKTICK_SYMBOL.test(sentence) || EXPLICIT_CODE_CLAIM.test(sentence);
  if (!anchoredToArtifact && AUTHORING_INSTRUCTION.test(sentence)) return false;

  if (EXPLICIT_CODE_CLAIM.test(sentence)) return true;
  if (!VERIFICATION_VERB.test(sentence)) return false;
  return CODE_CONTEXT.test(sentence) || anchoredToArtifact;
}

/** Afirmação sobre estado medido, com precedência sobre linguagem normativa. */
function isRuntimeObservation(sentence: string): boolean {
  if (OBSERVED_TRANSITION.test(sentence)) return true;
  return RUNTIME_CLAIM_PATTERN.test(sentence) && !NORMATIVE_PATTERN.test(sentence);
}

function citedSymbolOf(sentence: string, citedPath: string | null): string | null {
  const backtick = sentence.match(BACKTICK_SYMBOL)?.[1];
  // Um path em crase não é símbolo.
  if (backtick && !backtick.includes('/')) return backtick;
  const call = sentence.match(CALL_SYMBOL)?.[1];
  if (call && call !== citedPath) return call;
  // Remove o caminho antes de procurar identificador solto: `db.ts` de
  // `server/db.ts` não pode ser confundido com símbolo.
  const withoutPath = citedPath ? sentence.split(citedPath).join(' ') : sentence;
  const bare = withoutPath.match(BARE_SYMBOL)?.[0];
  return bare ?? null;
}

/**
 * Avalia as afirmações do texto contra o pacote de evidência.
 *
 * - `failed`: alegou verificação que a evidência não sustenta (caminho ausente,
 *   símbolo ausente do trecho, ou afirmação de runtime sem evidência tipada).
 * - `warning`: exigia inspeção mas a coleta veio vazia/degradada — nunca passa
 *   silenciosamente.
 * - `passed`: sem alegação pendente, ou toda alegação sustentada.
 */
export function evaluateFactualClaims(text: string, pkg: RepoEvidencePackage): FactualGateResult {
  const byFile = new Map(pkg.evidence.map((e) => [e.file, e]));
  const unsupported: FactualClaim[] = [];

  for (const sentence of auditableSentences(text)) {
    const citedPath = sentence.match(PATH_PATTERN)?.[0] ?? null;
    const citedSymbol = citedSymbolOf(sentence, citedPath);
    const isVerificationClaim = isCodeVerificationClaim(sentence, citedPath);
    const isRuntime = isRuntimeObservation(sentence);

    const push = (reason: FactualClaim['reason']) =>
      unsupported.push(
        Object.freeze({ claim: sentence.slice(0, 300), reason, citedPath, citedSymbol }),
      );

    // Requisito normativo ("máximo 500 linhas") prescreve o futuro; não é
    // afirmação sobre estado observado nem sobre o código atual.
    if (!isRuntime && !isVerificationClaim) continue;

    if (pkg.evidence.length === 0) {
      push('no_evidence');
      continue;
    }

    // Estado de runtime não é verificável por conteúdo de arquivo.
    if (isRuntime) {
      push('runtime_claim');
      continue;
    }

    // Daqui pra baixo só interessa quem ALEGOU verificação.
    if (!isVerificationClaim) continue;

    if (citedPath !== null && !byFile.has(citedPath)) {
      push('path_not_in_evidence');
      continue;
    }

    // Caminho sozinho não basta: "Cadeia de Import Confirmada: server/db.ts
    // apaga tudo" cita arquivo real e afirma COMPORTAMENTO que o trecho não
    // sustenta.
    if (citedSymbol === null) {
      push(citedPath === null ? 'no_evidence' : 'no_auditable_symbol');
      continue;
    }

    const candidates = citedPath ? [byFile.get(citedPath)!] : [...byFile.values()];
    const found = candidates.some(
      (e) =>
        e !== undefined && (e.symbols.includes(citedSymbol) || e.snippet.includes(citedSymbol)),
    );
    if (!found) push('symbol_not_in_snippet');
  }

  if (unsupported.length > 0) {
    return Object.freeze({
      status: 'failed' as const,
      requiresHumanReview: true,
      unsupportedClaims: Object.freeze(unsupported),
      reason: `${unsupported.length} afirmação(ões) de verificação sem evidência que as sustente`,
    });
  }

  if (pkg.degraded) {
    return Object.freeze({
      status: 'warning' as const,
      requiresHumanReview: true,
      unsupportedClaims: Object.freeze([] as FactualClaim[]),
      reason: pkg.reason ?? 'coleta de evidência degradada',
    });
  }

  return Object.freeze({
    status: 'passed' as const,
    requiresHumanReview: false,
    unsupportedClaims: Object.freeze([] as FactualClaim[]),
    reason: null,
  });
}
