/**
 * Etapa ÚNICA de coleta de evidência do repositório, executada antes do
 * roundtable.
 *
 * Problema que resolve (P0 de grounding): `ContextAssembler.assembleInternalContext`
 * devolve uma STRING — prosa de RAG + repo lock. Não existia nenhum objeto tipado
 * com arquivo/símbolo/trecho, então quando um agente escrevia "confirmado no
 * código" não havia nada contra o que conferir. A demanda 10330 atravessou um
 * ciclo inteiro de refinamento sobre uma premissa factualmente falsa sem que
 * nenhum gate percebesse.
 *
 * Este módulo NÃO é um novo framework de agentes: ele chama o runtime de
 * ferramentas que já existe (`agent-tools-registry.executeTool`) e, quando o
 * repositório da demanda é o próprio checkout local, lê do disco — fonte
 * verificável que não depende de credencial de rede.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { type Demand } from '@shared/schema';
import { logger } from '../utils/logger';
import { executeTool } from './agent-tools-registry';
import { resolveDemandRepoFullName } from '../utils/repo-context';
import { resolvePath } from '@shared/utils/paths';
import { screenAndFormat, type RetrievedChunk } from './retrieval-guardrail';

/** Um fato verificado no repositório. Sem `snippet`, não é evidência. */
export interface RepoEvidence {
  /** Ferramenta/fonte que produziu o fato (proveniência). */
  readonly tool: string;
  readonly file: string;
  /** Símbolos realmente presentes no trecho — base para o gate factual. */
  readonly symbols: readonly string[];
  readonly snippet: string;
  readonly verifiedAt: string;
}

export type EvidenceGateStatus = 'passed' | 'warning' | 'failed';

export interface RepoEvidencePackage {
  readonly evidence: readonly RepoEvidence[];
  /** True quando a demanda exige inspeção de repositório. */
  readonly inspectionRequired: boolean;
  /** True quando exigia inspeção e a coleta não trouxe nada utilizável. */
  readonly degraded: boolean;
  readonly reason: string | null;
}

/** Caminhos tipo `server/services/x.ts` citados no texto da demanda. */
const PATH_PATTERN = /\b(?:server|client|shared|scripts|config|tests)\/[\w\-./]+\.\w{2,4}\b/g;

/**
 * Demanda que pede diagnóstico/análise do código exige inspeção mesmo sem citar
 * arquivo — era o buraco que deixava "investigue a causa raiz" passar sem
 * nenhuma evidência coletada.
 */
const INSPECTION_INTENT_PATTERN =
  /\b(causa[- ]raiz|diagn[óo]stic|analis[ae]r? o c[óo]digo|an[áa]lise do c[óo]digo|auditori|investigu|por que (?:falha|quebra|n[ãa]o funciona)|refatorar?|regress[ãa]o|bug|corrig[ei]|stack ?trace)/i;

const MAX_FILES_INSPECTED = 5;
/** Exportado para o teste amarrar no valor REAL, não numa cópia literal. */
export const SNIPPET_MAX_CHARS = 4000;

/** Identificadores plausíveis num trecho de código (para casar com o claim). */
const SYMBOL_PATTERN = /\b[A-Za-z_$][\w$]{2,}\b/g;

function demandText(demand: Demand): string {
  return `${demand.title ?? ''}\n${demand.description ?? ''}`;
}

/** Caminhos citados, deduplicados e limitados. */
export function extractCitedPaths(demand: Demand): string[] {
  const matches = demandText(demand).match(PATH_PATTERN) ?? [];
  return [...new Set(matches)].slice(0, MAX_FILES_INSPECTED);
}

/**
 * A demanda exige inspeção de repositório? Sim quando cita caminhos OU quando
 * pede explicitamente diagnóstico/análise do código.
 */
export function demandRequiresRepoInspection(demand: Demand): boolean {
  if (extractCitedPaths(demand).length > 0) return true;
  return INSPECTION_INTENT_PATTERN.test(demandText(demand));
}

function emptyPackage(inspectionRequired: boolean, reason: string | null): RepoEvidencePackage {
  return Object.freeze({
    evidence: Object.freeze([] as RepoEvidence[]),
    inspectionRequired,
    degraded: inspectionRequired,
    reason,
  });
}

/**
 * Envelope REAL de `get_file_content` (ver tech-lead-tools.ts): `data` é um
 * objeto `{ path, content, ... }`, não uma string. A primeira versão fazia
 * `String(result.data)` e gravava `"[object Object]"` como evidência — e o teste
 * mascarava isso mockando `data` como string, contrato que nunca existiu.
 */
interface FileContentData {
  path?: unknown;
  content?: unknown;
}

function extractFileContent(
  data: unknown,
  fallbackPath: string,
): { path: string; content: string } | null {
  if (typeof data !== 'object' || data === null) return null;
  const { path: rawPath, content } = data as FileContentData;
  if (typeof content !== 'string' || content.trim().length === 0) return null;
  const filePath = typeof rawPath === 'string' && rawPath.trim() ? rawPath : fallbackPath;
  return { path: filePath, content };
}

/** Símbolos presentes no trecho — o gate exige que o citado esteja aqui. */
function extractSymbols(snippet: string): string[] {
  return [...new Set(snippet.match(SYMBOL_PATTERN) ?? [])];
}

/** `owner/repo` do git remote deste checkout, ou null. Resolvido uma vez. */
let localRepoCache: { value: string | null } | null = null;

export function __resetLocalRepoCacheForTests(): void {
  localRepoCache = null;
}

function localRepoFullName(): string | null {
  if (localRepoCache) return localRepoCache.value;
  let value: string | null = null;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: resolvePath('.'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
    if (match) value = `${match[1]}/${match[2]}`.toLowerCase();
  } catch {
    value = null;
  }
  localRepoCache = { value };
  return value;
}

/**
 * O checkout local só serve de evidência para o PRÓPRIO repositório.
 *
 * A versão anterior lia do disco antes de olhar `repoFullName`: uma demanda de
 * `empresa/outro-repo` recebia `shared/agent-roles.ts` do AiChatFlow1 como
 * evidência válida, com `degraded: false`. Isso é grounding falso — exatamente
 * o que este módulo existe para impedir.
 */
function isLocalRepo(repoFullName: string | null): boolean {
  if (!repoFullName) return false;
  const local = localRepoFullName();
  return local !== null && repoFullName.trim().toLowerCase() === local;
}

/**
 * Lê do checkout local — fonte verificável que não depende de credencial. Só é
 * chamada quando `isLocalRepo` confirmou a identidade do repositório.
 *
 * Contenção contra symlink: `statSync` SEGUE links, então `server/leak.ts ->
 * ../../.env` passava na checagem textual de prefixo e mandaria conteúdo de fora
 * do checkout para o LLM. Aqui o caminho é rejeitado se qualquer componente for
 * link (`lstatSync`) e o `realpath` precisa continuar dentro da raiz.
 *
 * A leitura é limitada a `SNIPPET_MAX_CHARS`: não faz sentido carregar um
 * arquivo inteiro na memória para descartar tudo menos o começo.
 */
function readLocalFile(filePath: string): { path: string; content: string } | null {
  let fd: number | null = null;
  try {
    const root = path.resolve(resolvePath('.'));
    const absolute = path.resolve(root, filePath);
    if (!absolute.startsWith(root + path.sep)) return null;

    // Nenhum componente do caminho pode ser symlink.
    let cursor = absolute;
    while (cursor !== root) {
      const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
      if (!stat) return null;
      if (stat.isSymbolicLink()) {
        logger.warn('repo-evidence: symlink rejeitado na contenção local', {
          context: { filePath, at: cursor },
        });
        return null;
      }
      cursor = path.dirname(cursor);
    }

    // Cinto e suspensório: o caminho resolvido tem de seguir dentro da raiz.
    const real = fs.realpathSync(absolute);
    if (!real.startsWith(root + path.sep)) return null;
    if (!fs.lstatSync(real).isFile()) return null;

    // Leitura limitada — nunca o arquivo inteiro.
    fd = fs.openSync(real, 'r');
    const buffer = Buffer.alloc(SNIPPET_MAX_CHARS);
    const bytes = fs.readSync(fd, buffer, 0, SNIPPET_MAX_CHARS, 0);
    const content = buffer.subarray(0, bytes).toString('utf8');
    if (!content.trim()) return null;
    return { path: filePath, content };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* fd já fechado */
      }
    }
  }
}

/**
 * Coleta evidência real para os caminhos citados. Nunca lança: falha de
 * ferramenta vira pacote degradado, que o caller traduz em
 * `requiresHumanReview`.
 */
export async function collectRepoEvidence(demand: Demand): Promise<RepoEvidencePackage> {
  const inspectionRequired = demandRequiresRepoInspection(demand);
  if (!inspectionRequired) {
    return Object.freeze({
      evidence: Object.freeze([] as RepoEvidence[]),
      inspectionRequired: false,
      degraded: false,
      reason: null,
    });
  }

  const citedPaths = extractCitedPaths(demand);
  if (citedPaths.length === 0) {
    return emptyPackage(true, 'demanda pede análise do código mas não cita arquivo verificável');
  }

  const repoFullName = resolveDemandRepoFullName(demand);
  const collected: RepoEvidence[] = [];

  const useLocalCheckout = isLocalRepo(repoFullName);

  for (const filePath of citedPaths) {
    let file = useLocalCheckout ? readLocalFile(filePath) : null;
    let tool = 'local_checkout';

    if (!file && repoFullName) {
      try {
        const result = await executeTool('get_file_content', { repoFullName, filePath });
        if (result.ok) {
          file = extractFileContent(result.data, filePath);
          tool = 'get_file_content';
          if (!file) {
            logger.info('repo-evidence: envelope inesperado da ferramenta', {
              context: { demandId: demand.id, filePath },
            });
          }
        } else {
          logger.info('repo-evidence: ferramenta não retornou conteúdo', {
            context: { demandId: demand.id, filePath, error: result.error },
          });
        }
      } catch (error) {
        logger.warn('repo-evidence: falha ao coletar evidência', {
          error: error instanceof Error ? error : undefined,
          context: { demandId: demand.id, filePath },
        });
      }
    }

    if (!file) continue;

    const snippet = file.content.slice(0, SNIPPET_MAX_CHARS);
    collected.push(
      Object.freeze({
        tool,
        file: file.path,
        symbols: Object.freeze(extractSymbols(snippet)),
        snippet,
        verifiedAt: new Date().toISOString(),
      }),
    );
  }

  if (collected.length === 0) {
    return emptyPackage(true, 'índice vazio ou ferramentas não retornaram evidência');
  }

  return Object.freeze({
    evidence: Object.freeze(collected),
    inspectionRequired: true,
    degraded: false,
    reason: null,
  });
}

/**
 * Bloco entregue à mesa. O conteúdo do repositório atravessa a MESMA fronteira
 * de dado não confiável já usada em `context-builder` — trecho de arquivo é
 * dado de terceiro, não instrução.
 */
export function formatEvidenceForPrompt(pkg: RepoEvidencePackage): string {
  if (!pkg.inspectionRequired) return '';

  if (pkg.degraded || pkg.evidence.length === 0) {
    return [
      '\n\n--- EVIDÊNCIA DO REPOSITÓRIO: NENHUMA ---',
      `Nenhuma evidência pôde ser coletada (${pkg.reason ?? 'motivo desconhecido'}).`,
      'É PROIBIDO afirmar "confirmado no código", "verificado em" ou equivalente.',
      'Trate toda premissa sobre o código como NÃO VERIFICADA e diga isso explicitamente.',
    ].join('\n');
  }

  // O trecho passa pelo MESMO screening do RAG (detecção de injeção +
  // neutralização de delimitadores, com nonce por request). Rótulo
  // "UNTRUSTED DATA" sozinho não é fronteira: o conteúdo seguia concatenado cru.
  const chunks: RetrievedChunk[] = pkg.evidence.map((e) => ({
    sourceKey: `${e.file} (via ${e.tool})`,
    docType: 'repo_evidence',
    content: e.snippet,
  }));

  return [
    '\n\n--- EVIDÊNCIA DO REPOSITÓRIO (IMUTÁVEL) ---',
    'Só afirme "confirmado no código" sobre arquivo E símbolo presentes abaixo.',
    'Contagem de registros/linhas em runtime NÃO é verificável por este bloco.',
    '',
    screenAndFormat(chunks, ' — evidência de repositório'),
    '--- FIM DA EVIDÊNCIA ---',
  ].join('\n');
}
