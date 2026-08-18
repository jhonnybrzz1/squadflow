/**
 * Spec 10014 — Gate de alucinações PRÉ-COMMIT do handoff.
 *
 * Última linha de defesa antes de `commitHandoffToRepo` escrever o spec-kit no
 * repositório destino. Complementa a spec 10012 (que age na GERAÇÃO do PRD): aqui
 * validamos o handoff FINAL contra a árvore real do repo-alvo.
 *
 * Recorte MVP (F1 + núcleo de F2): validador FileExistence (reusa
 * `CitedPathValidator`, paths E entidades) + EndpointValidator + DependencyValidator
 * + relatório acionável + modos dry-run/blocking, atrás da flag
 * `handoffValidationGateMode`.
 *
 * Filosofia de bloqueio (evita falsos positivos em arquivos PLANEJADOS): apenas
 * ENTIDADES citadas como existentes (componente/hook — ex.: "AssistenteDeCodigo")
 * e endpoints/dependências alucinados são `critical` e bloqueiam em modo
 * blocking. PATHS ausentes são `warning` (podem ser arquivos a criar) —
 * coletados/reportados, mas não bloqueiam. A whitelist (US4) e o dashboard
 * (US5) ficam para uma iteração futura (ver evidence.md).
 */
import { CitedPathValidator, type CitedPathValidationResult } from './cited-path-validator';
import { resolveKnownRepoPaths } from './cited-path-resolver';
import { gitHubService } from './github';
import { featureFlags } from './feature-flags';
import { logger } from '../utils/logger';
import { documentHallucinationTotal } from '../metrics';

export type GateMode = 'off' | 'dry-run' | 'blocking';
export type IssueSeverity = 'critical' | 'warning' | 'info';

export interface ValidationIssue {
  /** Validador que gerou a issue (ex.: 'FileExistence'). */
  validator: string;
  /** Tipo de referência: 'path' | 'component'. */
  refType: 'path' | 'component';
  /** Referência exata detectada no documento. */
  refValue: string;
  /** Localização real esperada, ou 'não encontrado'. */
  expectedLocation: string;
  severity: IssueSeverity;
  /** Documento onde a referência apareceu (ex.: 'spec.md'). */
  docTitle: string;
}

export interface HandoffValidationResult {
  passed: boolean;
  mode: GateMode;
  dryRun: boolean;
  issues: ValidationIssue[];
  /** Relatório em Markdown (tabela acionável ou empty-state). */
  report: string;
  /** `false` quando o índice de paths do repo não estava disponível. */
  indexAvailable: boolean;
}

export interface HandoffFileInput {
  path: string;
  content: string;
}

export interface GateContext {
  demandId?: number;
  mode?: GateMode;
}

/** Só validamos documentos de texto do spec-kit (spec.md, tasks.md, etc.). */
function isValidatableDoc(path: string): boolean {
  return /\.mdx?$/i.test(path);
}

function collectIssues(
  docTitle: string,
  pathResult: CitedPathValidationResult,
  entityResult: CitedPathValidationResult,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const entry of pathResult.ledger) {
    if (entry.action === 'marked') {
      issues.push({
        validator: 'FileExistence',
        refType: 'path',
        refValue: entry.path,
        expectedLocation: 'não encontrado',
        severity: 'warning', // pode ser arquivo planejado → não bloqueia
        docTitle,
      });
    }
  }
  for (const entry of entityResult.ledger) {
    if (entry.action === 'marked') {
      issues.push({
        validator: 'FileExistence',
        refType: 'component',
        refValue: entry.raw,
        expectedLocation: 'não encontrado',
        severity: 'critical', // citado como existente e não existe → alucinação
        docTitle,
      });
    }
  }
  return issues;
}

// ── FR-008: EndpointValidator ──────────────────────────────────────────────
// Detecta endpoints `/api/...` citados nos docs e verifica se algum arquivo de
// rotas do repo-alvo define essa string. Busca em arquivos `server/routes/**/*.ts`
// do índice; para cada candidato, faz fetch do conteúdo e grep pela string do
// endpoint. Custo limitado: só valida endpoints citados (geralmente poucos).

const ENDPOINT_PATTERN = /`(\/api\/[a-zA-Z0-9/_:.-]+)`/g;

/** Extrai endpoints `/api/...` citados em backticks do conteúdo. */
function extractEndpoints(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(ENDPOINT_PATTERN)) {
    out.push(m[1]);
  }
  return [...new Set(out)];
}

async function runEndpointValidator(
  docTitle: string,
  content: string,
  knownPaths: Set<string>,
  repoOwner: string,
  repoName: string,
): Promise<ValidationIssue[]> {
  const endpoints = extractEndpoints(content);
  if (endpoints.length === 0) return [];

  const routeFiles = [...knownPaths].filter((p) => /^server\/routes\/.*\.tsx?$/.test(p));
  if (routeFiles.length === 0) {
    // Sem arquivos de rotas no índice → não é possível verificar; não flag.
    return [];
  }

  const issues: ValidationIssue[] = [];
  // Para cada endpoint, busca em até N arquivos de rota (limite p/ custo de API).
  const MAX_ROUTE_FILES_TO_SCAN = 20;
  const candidates = routeFiles.slice(0, MAX_ROUTE_FILES_TO_SCAN);

  // Cache de conteúdo de arquivos de rota nesta execução do gate.
  const fileContents = new Map<string, string | null>();
  for (const file of candidates) {
    try {
      const safe = await gitHubService.getSafeTextContent(repoOwner, repoName, file);
      fileContents.set(file, safe.status === 'content' ? safe.content : null);
    } catch {
      fileContents.set(file, null);
    }
  }

  for (const endpoint of endpoints) {
    let found = false;
    for (const [, body] of fileContents) {
      if (body && body.includes(endpoint)) {
        found = true;
        break;
      }
    }
    if (!found) {
      issues.push({
        validator: 'Endpoint',
        refType: 'path',
        refValue: endpoint,
        expectedLocation: 'não encontrado em server/routes/',
        severity: 'critical',
        docTitle,
      });
    }
  }
  return issues;
}

// ── FR-009: DependencyValidator ─────────────────────────────────────────────
// Detecta bibliotecas citadas nos docs (ex.: `import foo from 'foo-lib'`) e
// verifica se estão declaradas em `package.json` do repo-alvo.

const IMPORT_PATTERN = /(?:from|import)\s+['"]([^.][^'"./][^'"]*?)['"]/g;

/** Extrai nomes de pacotes de imports (filtra paths relativos e builtin). */
function extractCitedPackages(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(IMPORT_PATTERN)) {
    const pkg = m[1];
    // Filtra paths relativos e scoped local: pega só npm packages.
    if (pkg.startsWith('.') || pkg.startsWith('/')) continue;
    // Normaliza scoped: @scope/name → mantém; subpath @scope/name/path → base.
    const base = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0];
    out.push(base);
  }
  return [...new Set(out)];
}

async function runDependencyValidator(
  docTitle: string,
  content: string,
  repoOwner: string,
  repoName: string,
): Promise<ValidationIssue[]> {
  const packages = extractCitedPackages(content);
  if (packages.length === 0) return [];

  let declared: Set<string> | null = null;
  try {
    const safe = await gitHubService.getSafeTextContent(repoOwner, repoName, 'package.json');
    if (safe.status === 'content') {
      const pkg = JSON.parse(safe.content) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      declared = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ]);
    }
  } catch {
    // package.json indisponível → não é possível verificar; não flag.
    return [];
  }
  if (declared === null) return [];

  const issues: ValidationIssue[] = [];
  for (const pkg of packages) {
    if (!declared.has(pkg)) {
      issues.push({
        validator: 'Dependency',
        refType: 'path',
        refValue: pkg,
        expectedLocation: 'não declarado em package.json',
        severity: 'critical',
        docTitle,
      });
    }
  }
  return issues;
}

function buildReport(result: Omit<HandoffValidationResult, 'report'>): string {
  if (result.issues.length === 0) {
    return [
      '## ✅ Gate de alucinações — sem pendências',
      '',
      'Nenhuma referência não verificada encontrada no handoff.',
      'Exemplos do que o gate procura: componentes citados como existentes que não têm',
      'arquivo no repo (ex.: `AssistenteDeCodigo`), caminhos inexistentes.',
    ].join('\n');
  }
  const critical = result.issues.filter((i) => i.severity === 'critical').length;
  const lines = [
    `## ${critical > 0 ? '🛑' : '⚠️'} Gate de alucinações — ${result.issues.length} referência(s) não verificada(s)`,
    '',
    `Modo: **${result.mode}**${result.dryRun ? ' (dry-run — não bloqueia)' : ''} · Críticas: **${critical}**`,
    '',
    '| Documento | Referência | Tipo | Local real | Severidade |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const i of result.issues) {
    const sev = i.severity === 'critical' ? '🔴 critical' : '🟡 warning';
    lines.push(
      `| ${i.docTitle} | \`${i.refValue}\` | ${i.refType} | ${i.expectedLocation} | ${sev} |`,
    );
  }
  return lines.join('\n');
}

/** Resolve o modo efetivo do gate (contexto sobrepõe a flag). */
function resolveMode(ctx: GateContext): GateMode {
  if (ctx.mode) return ctx.mode;
  return featureFlags.getFlags().handoffValidationGateMode ?? 'dry-run';
}

/**
 * Roda o gate de alucinações sobre os arquivos do handoff, contra a árvore real
 * de `repoFullName`. Não escreve nada; devolve o veredito e o relatório.
 *
 * `passed`:
 * - modo `off` → sempre `true` (no-op);
 * - modo `dry-run` → sempre `true` (coleta/loga, fail-open mesmo sem índice);
 * - modo `blocking` → `false` se houver issue `critical`, ou se o índice do repo
 *   estiver indisponível (fail-closed: não commita sem poder verificar).
 */
export async function runHandoffValidationGate(
  repoFullName: string,
  files: HandoffFileInput[],
  ctx: GateContext = {},
): Promise<HandoffValidationResult> {
  const mode = resolveMode(ctx);

  if (mode === 'off') {
    return {
      passed: true,
      mode,
      dryRun: false,
      issues: [],
      report: '',
      indexAvailable: false,
    };
  }

  const dryRun = mode === 'dry-run';
  const knownPaths = await resolveKnownRepoPaths(repoFullName);
  const indexAvailable = knownPaths !== null;

  // Índice indisponível: dry-run segue (fail-open); blocking reprova (fail-closed).
  if (!indexAvailable) {
    const partial: Omit<HandoffValidationResult, 'report'> = {
      passed: dryRun,
      mode,
      dryRun,
      issues: [],
      indexAvailable: false,
    };
    const report = buildReport(partial);
    logger.warn('Gate de alucinações: índice do repo indisponível', {
      context: { demandId: ctx.demandId, repoFullName, mode, passed: partial.passed },
    });
    return { ...partial, report };
  }

  const issues: ValidationIssue[] = [];
  // FR-017: owner/name split para buscar conteúdo de arquivos no repo-alvo.
  const slash = repoFullName.indexOf('/');
  const repoOwner = slash > 0 ? repoFullName.slice(0, slash) : '';
  const repoName = slash > 0 ? repoFullName.slice(slash + 1) : '';
  const canFetchContent = repoOwner !== '' && repoName !== '';

  for (const file of files) {
    if (!isValidatableDoc(file.path)) continue;
    const opts = { sourceLabel: file.path, demandId: ctx.demandId };
    const pathResult = CitedPathValidator.validate(file.content, knownPaths, opts);
    const entityResult = CitedPathValidator.validateEntities(file.content, knownPaths, opts);
    issues.push(...collectIssues(file.path, pathResult, entityResult));

    // FR-008/009: validadores de endpoint e dependência só rodam se for
    // possível buscar conteúdo no repo-alvo (token + owner/name válidos).
    if (canFetchContent) {
      try {
        const endpointIssues = await runEndpointValidator(
          file.path,
          file.content,
          knownPaths,
          repoOwner,
          repoName,
        );
        issues.push(...endpointIssues);
      } catch (error) {
        logger.warn('EndpointValidator: falha ao validar endpoints', {
          error: error instanceof Error ? error : undefined,
          context: { demandId: ctx.demandId, repoFullName, doc: file.path },
        });
      }
      try {
        const depIssues = await runDependencyValidator(
          file.path,
          file.content,
          repoOwner,
          repoName,
        );
        issues.push(...depIssues);
      } catch (error) {
        logger.warn('DependencyValidator: falha ao validar dependências', {
          error: error instanceof Error ? error : undefined,
          context: { demandId: ctx.demandId, repoFullName, doc: file.path },
        });
      }
    }
  }

  const criticalCount = issues.filter((i) => i.severity === 'critical').length;
  const passed = dryRun ? true : criticalCount === 0;

  const partial: Omit<HandoffValidationResult, 'report'> = {
    passed,
    mode,
    dryRun,
    issues,
    indexAvailable,
  };
  const report = buildReport(partial);

  // Métrica + log estruturado (US1: coleta em dry-run permite calibrar threshold).
  const outcome = !passed ? 'blocked' : issues.length > 0 ? 'flagged' : 'clean';
  documentHallucinationTotal.labels(outcome, 'handoff').inc();
  logger.info('Gate de alucinações do handoff', {
    context: {
      demandId: ctx.demandId,
      repoFullName,
      mode,
      passed,
      totalIssues: issues.length,
      criticalCount,
      issues: issues.map((i) => ({ doc: i.docTitle, ref: i.refValue, sev: i.severity })),
    },
  });

  return { ...partial, report };
}
