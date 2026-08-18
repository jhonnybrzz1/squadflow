/**
 * Model Version Comparator — extensible comparison strategies.
 *
 * Each strategy extracts a comparable version signature from a model id and
 * compares two candidates. The comparator never silently swaps variants
 * (pro vs flash, medium vs small) — that is enforced by family include/exclude
 * patterns before comparison even runs.
 *
 * Strategies:
 * - semantic-version: extract semver-like X.Y[.Z] from the id and compare.
 * - date-version: extract a YYYYMM or YYYYMMDD date token and compare.
 * - numeric-generation: extract a generation integer (e.g. m3, v4) and compare.
 * - provider-created-at: compare by the provider-reported `created` timestamp.
 * - explicit-priority: rank by configured preferred/excluded suffixes.
 * - native-latest-alias: the provider's own `*-latest` alias wins; no local
 *   heuristic overrides it.
 * - no-auto-comparison: never auto-compare; manual promotion only.
 */

import type { ComparisonStrategy, ModelFamily } from './model-family-rules';

export interface VersionSignature {
  strategy: ComparisonStrategy;
  /** Primary comparable value (higher = newer). */
  value: number;
  /** Secondary tiebreaker (e.g. suffix priority). */
  secondary?: number;
  /** Raw extracted token for audit/logging. */
  token: string;
}

export interface CompareResult {
  winner: 'current' | 'candidate' | 'tie' | 'incomparable';
  currentSignature: VersionSignature | null;
  candidateSignature: VersionSignature | null;
  reason: string;
}

/**
 * Extracts a semantic-version-like token (X.Y or X.Y.Z) from a model id and
 * returns a numeric signature. Returns null when no version token is found.
 */
function extractSemanticVersion(modelId: string): string | null {
  const match = modelId.match(/(\d+(?:\.\d+){1,2})/);
  return match ? match[1] : null;
}

function semanticVersionValue(token: string): number {
  const parts = token.split('.').map((p) => parseInt(p, 10));
  // Encode as major*1e6 + minor*1e3 + patch — sufficient for typical model versions.
  return (parts[0] || 0) * 1_000_000 + (parts[1] || 0) * 1_000 + (parts[2] || 0);
}

/**
 * Extracts a generation integer from tokens like `m3`, `v4`, `-m2.7`.
 */
function extractGeneration(modelId: string): number | null {
  // Match patterns like v4, m3, m2.7 — take the first numeric group after a letter.
  const match = modelId.match(/[vm](\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  return Number.isFinite(num) ? num : null;
}

/**
 * Extracts a date token (YYYYMM or YYYYMMDD) from a model id.
 */
function extractDateToken(modelId: string): string | null {
  const match = modelId.match(/(\d{6}|\d{8})/);
  return match ? match[1] : null;
}

/**
 * Builds a version signature for a model id under a given strategy.
 */
export function buildSignature(
  strategy: ComparisonStrategy,
  modelId: string,
  family: ModelFamily,
  createdAt?: Date,
): VersionSignature | null {
  switch (strategy) {
    case 'semantic-version': {
      const token = extractSemanticVersion(modelId);
      if (!token) return null;
      return { strategy, value: semanticVersionValue(token), token };
    }

    case 'numeric-generation': {
      const gen = extractGeneration(modelId);
      if (gen === null) return null;
      return { strategy, value: gen, token: `gen-${gen}` };
    }

    case 'date-version': {
      const token = extractDateToken(modelId);
      if (!token) return null;
      return { strategy, value: parseInt(token, 10), token };
    }

    case 'provider-created-at': {
      if (!createdAt) return null;
      return {
        strategy,
        value: createdAt.getTime(),
        token: createdAt.toISOString(),
      };
    }

    case 'explicit-priority': {
      // Rank by preferred suffixes (higher index = higher priority), then by
      // semantic version as a tiebreaker.
      const preferred = family.preferredSuffixes ?? [];
      const excluded = family.excludedSuffixes ?? [];
      const normalized = modelId.toLowerCase();

      let priority = -1;
      for (let i = 0; i < preferred.length; i++) {
        if (normalized.endsWith(preferred[i].toLowerCase())) {
          priority = i;
          break;
        }
      }
      // If an excluded suffix is present, deprioritize entirely.
      for (const ex of excluded) {
        if (normalized.endsWith(ex.toLowerCase())) {
          priority = -2;
          break;
        }
      }

      const semverToken = extractSemanticVersion(modelId);
      const secondary = semverToken ? semanticVersionValue(semverToken) : 0;
      return { strategy, value: priority, secondary, token: `priority-${priority}` };
    }

    case 'native-latest-alias': {
      // The provider's own *-latest alias is canonical. We only compare ids
      // that are also *-latest; otherwise the alias wins by definition.
      const isLatestAlias = /-latest$/.test(modelId);
      return {
        strategy,
        value: isLatestAlias ? 1 : 0,
        token: isLatestAlias ? 'native-latest' : 'versioned',
      };
    }

    case 'no-auto-comparison':
      return null;

    default:
      return null;
  }
}

/**
 * Compares the current active model id against a candidate under the family's
 * strategy. Returns which one wins, or `incomparable` when no signature can be
 * built for either side.
 */
export function compareModels(args: {
  family: ModelFamily;
  currentModelId: string;
  candidateModelId: string;
  candidateCreatedAt?: Date;
  currentCreatedAt?: Date;
}): CompareResult {
  const { family, currentModelId, candidateModelId, candidateCreatedAt, currentCreatedAt } = args;
  const strategy = family.comparisonStrategy;

  const currentSig = buildSignature(strategy, currentModelId, family, currentCreatedAt);
  const candidateSig = buildSignature(strategy, candidateModelId, family, candidateCreatedAt);

  if (!currentSig || !candidateSig) {
    return {
      winner: 'incomparable',
      currentSignature: currentSig,
      candidateSignature: candidateSig,
      reason: 'no-signature',
    };
  }

  if (candidateSig.value > currentSig.value) {
    return {
      winner: 'candidate',
      currentSignature: currentSig,
      candidateSignature: candidateSig,
      reason: 'higher-primary',
    };
  }
  if (candidateSig.value < currentSig.value) {
    return {
      winner: 'current',
      currentSignature: currentSig,
      candidateSignature: candidateSig,
      reason: 'lower-primary',
    };
  }

  // Tie on primary — use secondary if present
  const curSec = currentSig.secondary ?? 0;
  const candSec = candidateSig.secondary ?? 0;
  if (candSec > curSec) {
    return {
      winner: 'candidate',
      currentSignature: currentSig,
      candidateSignature: candidateSig,
      reason: 'higher-secondary',
    };
  }
  if (candSec < curSec) {
    return {
      winner: 'current',
      currentSignature: currentSig,
      candidateSignature: candidateSig,
      reason: 'lower-secondary',
    };
  }

  return {
    winner: 'tie',
    currentSignature: currentSig,
    candidateSignature: candidateSig,
    reason: 'equal',
  };
}
