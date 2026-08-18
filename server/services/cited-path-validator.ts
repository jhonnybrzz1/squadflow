import { logger } from '../utils/logger';
import { citedPathViolationsTotal } from '../metrics';

/**
 * Provenance de um caminho de arquivo citado num documento gerado (PRD/TSD/resposta
 * de agente). Espelha o `NumericIntegrityValidator`, mas para arquivos: registra cada
 * path detectado e se ele EXISTE de fato no repositório-alvo.
 *
 * `exists: null` significa "não verificável" — não tínhamos um índice de caminhos
 * confiável (sem token, repo inacessível, ou árvore truncada). Nesse caso NÃO marcamos
 * nada (fail-safe), pela mesma filosofia conservadora do resto do pipeline: marcar um
 * arquivo real como inexistente é pior do que deixar passar.
 */
export interface CitedPathProvenance {
  /** Caminho normalizado (sem `./`, `/` inicial; barras posix). */
  path: string;
  /** Token exato como apareceu no conteúdo. */
  raw: string;
  exists: boolean | null;
  action: 'kept' | 'marked' | 'skipped';
}

export interface CitedPathValidationResult {
  cleanContent: string;
  /** Quantos paths citados foram confirmados como inexistentes e marcados. */
  missingCount: number;
  ledger: CitedPathProvenance[];
}

export interface CitedPathValidationOptions {
  sourceLabel?: string;
  demandId?: number;
}

/** Spec 10012 FR-005/006: resumo agregado de grounding de um documento gerado. */
export interface GroundingSummary {
  /** Claims verificáveis (que tinham índice de repo; `exists !== null`). */
  totalClaims: number;
  /** Claims verificáveis confirmados como existentes. */
  verified: number;
  /** Claims verificáveis marcados como inexistentes. */
  unverified: number;
  /** `unverified / totalClaims` (0 quando não há claims verificáveis). */
  unverifiedClaimsRatio: number;
  /** `true` quando >50% dos claims verificáveis falharam (FR-005). */
  degraded: boolean;
}

/**
 * Spec 10012 FR-005/006: agrega os resultados de `validate`/`validateEntities` num
 * resumo de grounding (totais, ratio de não-verificados e flag de degradação). Puro e
 * determinístico. `exists === null` (índice indisponível) não conta como claim verificável.
 */
export function summarizeGrounding(results: CitedPathValidationResult[]): GroundingSummary {
  const ledger = results.flatMap((r) => r.ledger);
  const totalClaims = ledger.filter((l) => l.exists !== null).length;
  const unverified = results.reduce((sum, r) => sum + r.missingCount, 0);
  const verified = totalClaims - unverified;
  const unverifiedClaimsRatio = totalClaims > 0 ? unverified / totalClaims : 0;
  const degraded = totalClaims > 0 && unverifiedClaimsRatio > 0.5;
  return { totalClaims, verified, unverified, unverifiedClaimsRatio, degraded };
}

/** Marcador anexado após um arquivo citado que não existe no repositório. */
export const MISSING_PATH_MARKER = ' ⚠️[ARQUIVO NÃO ENCONTRADO]';

/** Marcador para identificador de componente/hook referenciado que não existe no repo. */
export const MISSING_ENTITY_MARKER = ' ⚠️[NÃO ENCONTRADO NO REPO]';

// Spec 10009 US2: identificadores de código (componente/hook) referenciados como se
// existissem — ex.: "o componente AssistenteDeCodigo", "hook (useDemandContext)".
// Ancorado na palavra-chave (componente/hook) para não marcar PascalCase de prosa
// (ex.: "API REST", "SQL"). Só PascalCase/useXxx com 3+ chars.
const ENTITY_REGEX =
  /\b(?:componentes?|hooks?)[\s(`'"]+((?:use[A-Z][A-Za-z0-9]+)|(?:[A-Z][A-Za-z0-9]{2,}))/gi;

/** Normaliza um identificador/arquivo para comparação casing-agnóstica (PascalCase↔kebab). */
function normalizeEntity(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function basenameNoExt(p: string): string {
  const base = basename(p);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? base : base.slice(0, dot);
}

// Extensões reconhecidas como "arquivo de código/config/doc". Restringir a esta lista
// evita falsos positivos óbvios da prosa ("e.g.", "i.e.", "vs.", "v2.0", "etc.").
const FILE_EXT =
  '(?:tsx?|jsx?|mjs|cjs|json|mdx?|ya?ml|s?css|sass|less|html?|sql|sh|bash|py|rb|go|java|kts?|php|cpp|hpp|cs|rs|vue|svelte|txt|env|toml|ini|xml|prisma|graphql|gql|proto|lock|conf|cfg|csv)';

// Token de path: prefixo opcional (./ ../ /), zero+ segmentos de diretório, e um
// nome.ext final (nome pode ter pontos, ex.: vite.config.ts). O lookbehind impede
// casar no meio de outro token — em particular, dentro de URLs (a parte de path vem
// precedida por "/"), então caminhos colados em links não são extraídos.
// O `(?![A-Za-z0-9])` após a extensão garante o casamento da extensão mais longa
// válida (ex.: "package.json" não casa como "package.js", já que `jsx?` casaria "js").
const PATH_REGEX = new RegExp(
  `(?<![\\w@./-])((?:\\.{0,2}/)?(?:[\\w.-]+/)+[\\w.-]+\\.${FILE_EXT}(?![A-Za-z0-9])|[\\w.-]+\\.${FILE_EXT}(?![A-Za-z0-9]))`,
  'gi',
);

/** Remove `./`, `../` e `/` iniciais e normaliza barras. */
function normalizePath(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .replace(/^(?:\.\.?\/)+/, '')
    .replace(/^\/+/, '')
    .trim();
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

export class CitedPathValidator {
  /**
   * Escaneia `content` por arquivos citados e marca, de forma DETERMINÍSTICA, aqueles
   * que não existem em `knownPaths` (caminhos repo-relativos reais do repositório-alvo).
   *
   * `knownPaths === null` → índice indisponível: não marca nada (fail-safe). Idempotente:
   * rodar duas vezes não duplica o marcador.
   */
  static validate(
    content: string,
    knownPaths: Set<string> | null,
    options: CitedPathValidationOptions = {},
  ): CitedPathValidationResult {
    const ledger: CitedPathProvenance[] = [];

    // Índices em minúsculas para comparação case-insensitive (lenient: GitHub é
    // case-sensitive, mas preferimos não marcar a marcar errado por diferença de caixa).
    const fullSet =
      knownPaths === null ? null : new Set([...knownPaths].map((p) => p.toLowerCase()));
    const baseSet =
      knownPaths === null ? null : new Set([...knownPaths].map((p) => basename(p.toLowerCase())));
    const fullList = knownPaths === null ? [] : [...fullSet!];

    const pathExists = (norm: string): boolean => {
      const lower = norm.toLowerCase();
      if (fullSet!.has(lower)) return true;
      if (lower.includes('/')) {
        // Caminho parcial: aceita se for sufixo de algum caminho real (ex.: citaram
        // "services/foo.ts" e existe "server/services/foo.ts").
        return fullList.some((p) => p.endsWith('/' + lower));
      }
      // Nome simples sem diretório: casa por basename.
      return baseSet!.has(lower);
    };

    const matches: { raw: string; norm: string; start: number; end: number }[] = [];
    PATH_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PATH_REGEX.exec(content)) !== null) {
      const raw = m[0];
      const norm = normalizePath(raw);
      if (!norm) continue;
      matches.push({ raw, norm, start: m.index, end: m.index + raw.length });
    }

    // Sem índice confiável → não marca; só registra como 'skipped'.
    if (knownPaths === null) {
      for (const match of matches) {
        ledger.push({ path: match.norm, raw: match.raw, exists: null, action: 'skipped' });
      }
      return { cleanContent: content, missingCount: 0, ledger };
    }

    let missingCount = 0;
    let cleanContent = content;

    // Aplica de trás para frente para preservar os offsets.
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      const exists = pathExists(match.norm);
      if (exists) {
        ledger.push({ path: match.norm, raw: match.raw, exists: true, action: 'kept' });
        continue;
      }
      // Idempotência: não anexa o marcador se já estiver logo após o token.
      const alreadyMarked = cleanContent.startsWith(MISSING_PATH_MARKER, match.end);
      if (alreadyMarked) {
        ledger.push({ path: match.norm, raw: match.raw, exists: false, action: 'marked' });
        continue;
      }
      cleanContent =
        cleanContent.slice(0, match.end) + MISSING_PATH_MARKER + cleanContent.slice(match.end);
      missingCount++;
      ledger.push({ path: match.norm, raw: match.raw, exists: false, action: 'marked' });
    }

    if (missingCount > 0) {
      citedPathViolationsTotal.labels(options.sourceLabel ?? 'documento').inc(missingCount);
      logger.info(
        `Grounding de arquivos (${options.sourceLabel ?? 'documento'}): caminhos inexistentes marcados`,
        {
          context: {
            demandId: options.demandId,
            missingCount,
            citedTotal: matches.length,
            missing: ledger.filter((l) => l.action === 'marked').map((l) => l.path),
          },
        },
      );
    }

    return { cleanContent, missingCount, ledger };
  }

  /**
   * Spec 10009 US2 — grounding de IDENTIFICADORES (componente/hook) citados como
   * existentes: marca, de forma determinística, os que não têm arquivo correspondente
   * em `knownPaths` (comparação casing-agnóstica, PascalCase↔kebab). Fecha o buraco
   * que deixou "AssistenteDeCodigo" passar (não é path, então `validate` não pega).
   *
   * Filosofia igual à de paths: MARCA, não rejeita — um componente legitimamente
   * PROPOSTO também é "não encontrado no repo", e a marca é informação honesta para o
   * revisor, não um falso positivo. `knownPaths === null` → não marca nada (fail-safe).
   */
  static validateEntities(
    content: string,
    knownPaths: Set<string> | null,
    options: CitedPathValidationOptions = {},
  ): CitedPathValidationResult {
    const ledger: CitedPathProvenance[] = [];

    const matches: { raw: string; norm: string; end: number }[] = [];
    ENTITY_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ENTITY_REGEX.exec(content)) !== null) {
      const id = m[1];
      matches.push({ raw: id, norm: normalizeEntity(id), end: m.index + m[0].length });
    }

    if (knownPaths === null) {
      for (const match of matches) {
        ledger.push({ path: match.raw, raw: match.raw, exists: null, action: 'skipped' });
      }
      return { cleanContent: content, missingCount: 0, ledger };
    }

    const knownNorm = new Set([...knownPaths].map((p) => normalizeEntity(basenameNoExt(p))));
    const entityExists = (norm: string): boolean => knownNorm.has(norm);

    let missingCount = 0;
    let cleanContent = content;
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      if (entityExists(match.norm)) {
        ledger.push({ path: match.raw, raw: match.raw, exists: true, action: 'kept' });
        continue;
      }
      if (cleanContent.startsWith(MISSING_ENTITY_MARKER, match.end)) {
        ledger.push({ path: match.raw, raw: match.raw, exists: false, action: 'marked' });
        continue;
      }
      cleanContent =
        cleanContent.slice(0, match.end) + MISSING_ENTITY_MARKER + cleanContent.slice(match.end);
      missingCount++;
      ledger.push({ path: match.raw, raw: match.raw, exists: false, action: 'marked' });
    }

    if (missingCount > 0) {
      citedPathViolationsTotal.labels(options.sourceLabel ?? 'entidade').inc(missingCount);
      logger.info(
        `Grounding de entidades (${options.sourceLabel ?? 'documento'}): componentes/hooks inexistentes marcados`,
        {
          context: {
            demandId: options.demandId,
            missingCount,
            citedTotal: matches.length,
            missing: ledger.filter((l) => l.action === 'marked').map((l) => l.raw),
          },
        },
      );
    }

    return { cleanContent, missingCount, ledger };
  }
}
