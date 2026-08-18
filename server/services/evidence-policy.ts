/**
 * Política de evidência e baseline por tipo de demanda (spec 007).
 *
 * Módulo AUXILIAR do ContextBuilder — centraliza:
 *  - resolução de `demandTypeRules` (config/feature-flags.json) com aliases e
 *    fallback conservador (FR-001..006);
 *  - whitelist de extensões candidatas à verificação (FR-004/FR-014);
 *  - cache LRU/TTL de validação de paths (FR-016/FR-017);
 *  - eventos estruturados de auditoria via Winston (FR-020..022).
 *
 * NÃO é um segundo pipeline: a validação de existência continua no
 * ContextBuilder, que consome este módulo.
 */
import { featureFlags } from './feature-flags';
import { logger } from '../utils/logger';
import { getDemandTypeConfig, isDemandType } from '@shared/demand-types';

export interface DemandTypeRule {
  requireBaseline: boolean;
  evidenceMode: 'verified' | 'conceptual';
  /** Sempre false — existe para tornar a política explícita, não para habilitar. */
  allowHallucinatedPaths: false;
}

export interface ResolvedDemandTypeRule {
  /** Chave canônica de config (`bug`, `exploratoryAnalysis`, ...) ou `unknown`. */
  ruleKey: string;
  rule: DemandTypeRule;
  source: 'config' | 'fallback';
}

/** FR-005: errar para o lado da exigência — nunca fabrica evidência. */
export const CONSERVATIVE_FALLBACK_RULE: DemandTypeRule = {
  requireBaseline: true,
  evidenceMode: 'verified',
  allowHallucinatedPaths: false,
};

/**
 * Aliases de entrada legados: a config usa `canonicalDemandType`; valores
 * persistidos em português e aliases antigos continuam resolvendo para ela.
 */
const CANONICAL_TO_CONFIG_ALIAS: Record<string, string> = {
  discovery: 'discovery',
  bug: 'bug',
  analise_exploratoria: 'exploratoryAnalysis',
  nova_funcionalidade: 'newFeature',
  melhoria: 'improvement',
  security: 'security',
  refactoring: 'refactoring',
  infraestrutura: 'infrastructure',
  infrastructure: 'infrastructure',
  exploratoryanalysis: 'exploratoryAnalysis',
  newfeature: 'newFeature',
  // Aliases antigos seguem aceitos como input, mas não como chave de config.
  bugfix: 'bug',
  analysis: 'exploratoryAnalysis',
  new_feature: 'newFeature',
  improvement: 'improvement',
};

export function resolveDemandTypeRule(demandType: string | undefined): ResolvedDemandTypeRule {
  const normalized = demandType?.trim();
  const aliasKey =
    normalized && isDemandType(normalized)
      ? getDemandTypeConfig(normalized).canonicalDemandType
      : normalized
        ? CANONICAL_TO_CONFIG_ALIAS[normalized.toLowerCase()]
        : undefined;
  if (!aliasKey) {
    return { ruleKey: 'unknown', rule: CONSERVATIVE_FALLBACK_RULE, source: 'fallback' };
  }

  const configured = featureFlags.getFlags().demandTypeRules?.[aliasKey];
  if (!configured) {
    return { ruleKey: aliasKey, rule: CONSERVATIVE_FALLBACK_RULE, source: 'fallback' };
  }

  return {
    ruleKey: aliasKey,
    rule: {
      requireBaseline: configured.requireBaseline,
      evidenceMode: configured.evidenceMode,
      // FR-003: allowHallucinatedPaths é false por contrato, independente da config.
      allowHallucinatedPaths: false,
    },
    source: 'config',
  };
}

/** Whitelist de extensões candidatas — nunca dispensa verificação (FR-014). */
export function getEvidenceExtensions(): string[] {
  const configured = featureFlags.getFlags().evidenceExtensions;
  return Array.isArray(configured) && configured.length > 0
    ? configured
    : ['.ts', '.tsx', '.json', '.js', '.jsx', '.css', '.md'];
}

// ============================================
// Cache de validação de path (FR-016/FR-017)
// ============================================

interface PathCacheEntry {
  exists: boolean;
  expiresAt: number;
}

export const PATH_CACHE_MAX_ENTRIES = 200;
export const PATH_CACHE_TTL_MS = 30_000;

/**
 * LRU + TTL. Armazena apenas resultados definitivos (existe/não existe) —
 * `unverifiable` nunca é cacheado (indisponibilidade não deve "grudar").
 * A ordem de inserção do Map é usada como ordem de recência (get reinsere).
 */
export class PathValidationCache {
  private entries = new Map<string, PathCacheEntry>();

  constructor(
    private readonly maxEntries = PATH_CACHE_MAX_ENTRIES,
    private readonly ttlMs = PATH_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private key(repoId: string, revision: string | undefined, path: string): string {
    const normalizedPath = path
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^(?:\.\/)+/, '');
    return `${repoId}@${revision ?? '-'}:${normalizedPath}`;
  }

  get(repoId: string, revision: string | undefined, path: string): boolean | undefined {
    const key = this.key(repoId, revision, path);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // LRU: reposiciona como mais recente.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.exists;
  }

  set(repoId: string, revision: string | undefined, path: string, exists: boolean): void {
    const key = this.key(repoId, revision, path);
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { exists, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Instância compartilhada da rodada (mesmo processo serve agentes e documento). */
export const pathValidationCache = new PathValidationCache();

// ============================================
// Eventos estruturados (FR-020..022)
// ============================================
// Cada linha é uma OBSERVAÇÃO bruta; taxas são agregadas fora do runtime
// (SC-007: A MEDIR — sem baseline). Nunca inclui token, segredo, prompt ou
// resposta integral (FR-021).

export function emitHallucinatedPathBlocked(event: {
  path: string;
  demandType: string;
  repoId: string;
  demandId?: number;
}): void {
  logger.info('Evidence policy: path alucinado bloqueado', {
    context: {
      metric_name: 'hallucinated_path_blocked',
      demand_type: event.demandType,
      repo_id: event.repoId,
      path: event.path,
      demand_id: event.demandId,
    },
  });
}

export function emitBaselineRequirementSkipped(event: {
  demandType: string;
  demandId?: number;
}): void {
  logger.info('Evidence policy: baseline dispensado para o tipo da demanda', {
    context: {
      metric_name: 'baseline_requirement_skipped',
      demand_type: event.demandType,
      demand_id: event.demandId,
    },
  });
}

export function emitContractFalsePositiveObservation(event: {
  /** true = path validado; false = rejeitado; null = fonte indisponível (unverifiable). */
  valid: boolean | null;
  demandType: string;
  repoId: string;
  path?: string;
  demandId?: number;
}): void {
  logger.info('Evidence policy: observação de validação de contrato', {
    context: {
      // Nome legado preservado; cada linha é uma observação, não uma taxa (FR-022).
      metric_name: 'contract_false_positive_rate',
      demand_type: event.demandType,
      repo_id: event.repoId,
      path: event.path,
      valid: event.valid,
      demand_id: event.demandId,
    },
  });
}

// ============================================
// Resultado estruturado de validação (FR-011/012/013)
// ============================================

export interface PathValidationResult {
  validPaths: string[];
  rejectedPaths: string[];
  /** Fonte indisponível: nunca promovidos a válidos nem tratados como inexistentes (FR-012). */
  unverifiablePaths: string[];
  /** true quando houve rejeição — bloqueia a alegação de evidência, não a orquestração. */
  block: boolean;
  reason: 'path_not_found' | 'no_repository' | 'unsafe_path' | null;
}

export function emptyPathValidationResult(): PathValidationResult {
  return { validPaths: [], rejectedPaths: [], unverifiablePaths: [], block: false, reason: null };
}
