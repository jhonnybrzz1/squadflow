import { resolvePath } from '@shared/utils/paths';
/**
 * Model Family Rules — typed, validated configuration for model families.
 *
 * Each family declares:
 * - a stable alias (e.g. `mimo-pro-latest`);
 * - the provider homologated to serve it;
 * - the initial concrete model id (emergency fallback seed);
 * - include/exclude regex patterns for candidate filtering;
 * - minimum context length and required modalities;
 * - a comparison strategy used by the version comparator;
 * - optional preferred/excluded suffixes for explicit-priority families;
 * - autoPromote flag (default false — manual promotion by default).
 *
 * The config lives in `config/model-families.json` and is validated with Zod
 * at load time. Adding a new family does NOT require changes to the resolver
 * or comparator — only this config file.
 */

import fs from 'fs';
import { z } from 'zod';
import { logger } from '../utils/logger';

export type ComparisonStrategy =
  | 'semantic-version'
  | 'date-version'
  | 'numeric-generation'
  | 'provider-created-at'
  | 'explicit-priority'
  | 'native-latest-alias'
  | 'no-auto-comparison';

export const comparisonStrategySchema = z.enum([
  'semantic-version',
  'date-version',
  'numeric-generation',
  'provider-created-at',
  'explicit-priority',
  'native-latest-alias',
  'no-auto-comparison',
]);

export const modelFamilySchema = z.object({
  alias: z.string().min(1),
  family: z.string().min(1),
  provider: z.string().min(1),
  initialModelId: z.string().min(1),
  fallbackModelId: z.string().min(1).optional(),
  includePatterns: z.array(z.string()).default([]),
  excludePatterns: z.array(z.string()).default([]),
  minimumContextLength: z.number().int().min(0).default(0),
  requiredInputModalities: z.array(z.string()).default([]),
  comparisonStrategy: comparisonStrategySchema,
  preferredSuffixes: z.array(z.string()).optional(),
  excludedSuffixes: z.array(z.string()).optional(),
  autoPromote: z.boolean().default(false),
});

export const modelFamiliesConfigSchema = z.object({
  version: z.number().int().min(1),
  families: z.array(modelFamilySchema),
});

export type ModelFamily = z.infer<typeof modelFamilySchema>;
export type ModelFamiliesConfig = z.infer<typeof modelFamiliesConfigSchema>;

const DEFAULT_CONFIG_PATH = resolvePath('config/model-families.json');

let cachedConfig: ModelFamiliesConfig | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

/**
 * Loads and validates the model families config. Falls back to an empty
 * config (never throws) so the application can still start — the static
 * fallback in the registry covers resolution when this is unavailable.
 */
export function loadModelFamiliesConfig(
  configPath: string = process.env.MODEL_FAMILIES_CONFIG_PATH || DEFAULT_CONFIG_PATH,
): ModelFamiliesConfig {
  const now = Date.now();
  if (cachedConfig && now - cachedAt < CACHE_TTL_MS) {
    return cachedConfig;
  }

  try {
    if (!fs.existsSync(configPath)) {
      logger.warn(`[model-family-rules] Config not found at ${configPath}`);
      cachedConfig = { version: 1, families: [] };
      cachedAt = now;
      return cachedConfig;
    }

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const parsed = modelFamiliesConfigSchema.parse(raw);
    cachedConfig = parsed;
    cachedAt = now;
    return parsed;
  } catch (error) {
    logger.error('[model-family-rules] Failed to load/validate config', {
      error: error instanceof Error ? error : undefined,
    });
    cachedConfig = { version: 1, families: [] };
    cachedAt = now;
    return cachedConfig;
  }
}

/** Clears the in-memory cache. Useful for tests and admin reload. */
export function clearModelFamiliesCache(): void {
  cachedConfig = null;
  cachedAt = 0;
}

/** Returns the family matching a given alias, or undefined. */
export function findFamilyByAlias(alias: string): ModelFamily | undefined {
  return loadModelFamiliesConfig().families.find((f) => f.alias === alias);
}

/**
 * Returns the family that *owns* the given concrete model id, used to resolve
 * a concrete id back to its family/alias.
 *
 * A concrete id is frequently reused as the `fallbackModelId` of several
 * unrelated families (e.g. `mistral-medium-3.5` is the fallback for
 * `mimo-general-latest`, `minimax-m-latest`, `deepseek-v4-pro-latest`, ...)
 * while also being the `initialModelId` — the actual owning family — of
 * exactly one family (`mistral-medium-latest`). Matching on `fallbackModelId`
 * first would pick an arbitrary, unrelated family (array order), which is the
 * bug this function guards against. So: match `initialModelId` first (the
 * unambiguous owner), and only fall back to `fallbackModelId` when no family
 * owns the id directly.
 */
export function findFamilyByModelId(modelId: string): ModelFamily | undefined {
  const normalized = modelId.toLowerCase();
  const families = loadModelFamiliesConfig().families;

  const owner = families.find((f) => f.initialModelId.toLowerCase() === normalized);
  if (owner) return owner;

  return families.find((f) => f.fallbackModelId && f.fallbackModelId.toLowerCase() === normalized);
}

/**
 * Applies family rules to a candidate model id. Returns true when the id is
 * eligible (matches an include pattern, no exclude pattern, and is not in
 * the default exclusion set for preview/beta/experimental/free variants).
 */
export function isEligibleCandidate(
  family: ModelFamily,
  modelId: string,
  context?: {
    contextLength?: number;
    inputModalities?: string[];
    pricing?: { prompt?: number; completion?: number };
  },
): { eligible: boolean; reason?: string } {
  const normalized = modelId.toLowerCase();

  // Default automatic exclusions (security rule 3.3)
  const defaultExcludes = ['preview', 'beta', 'experimental', ':free', 'early-access'];
  for (const ex of defaultExcludes) {
    if (normalized.includes(ex)) {
      return { eligible: false, reason: `default-exclude:${ex}` };
    }
  }

  // Zero-price exclusion (MED-01): a model priced at exactly $0 for both prompt
  // and completion is a free/promotional tier that can be rate-limited or
  // withdrawn without notice — exclude it the same way as a `:free` suffix.
  // Only applied when pricing is actually reported (absent pricing is not
  // treated as free).
  const pricing = context?.pricing;
  if (
    pricing &&
    typeof pricing.prompt === 'number' &&
    typeof pricing.completion === 'number' &&
    pricing.prompt === 0 &&
    pricing.completion === 0
  ) {
    return { eligible: false, reason: 'zero-price-free-tier' };
  }

  // Family-specific exclude patterns
  for (const pattern of family.excludePatterns) {
    try {
      if (new RegExp(pattern, 'i').test(modelId)) {
        return { eligible: false, reason: `exclude-pattern:${pattern}` };
      }
    } catch (_) {
      // Ignore invalid regex — logged at config load
    }
  }

  // Family-specific excluded suffixes
  if (family.excludedSuffixes) {
    for (const suffix of family.excludedSuffixes) {
      if (normalized.endsWith(suffix.toLowerCase())) {
        return { eligible: false, reason: `excluded-suffix:${suffix}` };
      }
    }
  }

  // Include patterns — at least one must match
  if (family.includePatterns.length > 0) {
    const matched = family.includePatterns.some((pattern) => {
      try {
        return new RegExp(pattern, 'i').test(modelId);
      } catch (_) {
        return false;
      }
    });
    if (!matched) {
      return { eligible: false, reason: 'no-include-pattern-match' };
    }
  }

  // Minimum context length
  if (
    family.minimumContextLength > 0 &&
    context?.contextLength !== undefined &&
    context.contextLength < family.minimumContextLength
  ) {
    return {
      eligible: false,
      reason: `context-below-minimum:${context.contextLength}<${family.minimumContextLength}`,
    };
  }

  // Required input modalities
  if (family.requiredInputModalities.length > 0 && context?.inputModalities) {
    const missing = family.requiredInputModalities.filter(
      (m) => !context.inputModalities!.map((x) => x.toLowerCase()).includes(m.toLowerCase()),
    );
    if (missing.length > 0) {
      return { eligible: false, reason: `missing-modality:${missing.join(',')}` };
    }
  }

  return { eligible: true };
}
