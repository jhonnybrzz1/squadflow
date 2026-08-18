/**
 * Model Registry Bridge — opt-in integration layer that resolves aliases to
 * concrete model ids before existing routing/governance code runs.
 *
 * Design principle: the registry is a *progressive enhancement*. When disabled
 * (default during migration), all functions pass through unchanged. When
 * enabled via MODEL_REGISTRY_ENABLED=true, aliases are resolved to their
 * active model ids before governance validation.
 *
 * This keeps the existing hardcoded ids working as-is while allowing new
 * agent YAML files to reference stable aliases like `mimo-pro-latest`.
 */

import { resolveModelIdSafe, resolveModelWithFallback, modelRegistry } from './model-registry';
import { findFamilyByAlias, findFamilyByModelId } from './model-family-rules';
import { logger } from '../utils/logger';

const REGISTRY_ENABLED = process.env.MODEL_REGISTRY_ENABLED === 'true';

export function isModelRegistryEnabled(): boolean {
  return REGISTRY_ENABLED;
}

// Re-export for convenience (single import surface for callers)
export { resolveModelIdSafe, resolveModelWithFallback };

interface DefaultModelResolution {
  modelId: string;
  fallbackId?: string;
  alias: string;
  provider: string;
}

/**
 * Resolves a *default* model id (the hardcoded id set by agent policy or
 * YAML config) to the family's currently active model id.
 *
 * Concrete ids intentionally "win" inside `ModelRegistry.resolve()` — that
 * behavior exists so explicit/direct callers are never silently overridden.
 * But the hot path (chat generation/streaming) always starts from a
 * hardcoded default id, so resolving it as-is would never reflect a
 * promotion or rollback. Here we look up the family that owns the default
 * id and resolve its *alias* instead, which always reads the persisted
 * `activeModelId` (i.e. the real effect of promote/rollback).
 *
 * Returns `undefined` when the registry is disabled, the input is empty, or
 * the id/alias does not belong to any known family — callers should keep
 * using the original id unchanged in that case.
 */
async function resolveActiveModelForDefault(
  defaultModelId: string | undefined,
): Promise<DefaultModelResolution | undefined> {
  if (!REGISTRY_ENABLED || !defaultModelId) return undefined;

  const family = findFamilyByAlias(defaultModelId) ?? findFamilyByModelId(defaultModelId);
  if (!family) return undefined;

  try {
    const resolved = await modelRegistry.resolve(family.alias);
    return {
      modelId: resolved.modelId,
      fallbackId: resolved.fallbackId,
      alias: family.alias,
      provider: resolved.provider,
    };
  } catch (error) {
    logger.debug('[model-registry-bridge] resolveActiveModelForDefault pass-through', {
      error: error instanceof Error ? error : undefined,
      defaultModelId,
    });
    return undefined;
  }
}

export interface ModelRegistryOverrideResult<T> {
  options: T;
  /** Alias bound to the resolved primary model, when the registry applied an override. */
  primaryAlias?: string;
  /** Alias bound to the resolved fallback model, when the registry applied an override. */
  fallbackAlias?: string;
  /** Provider the registry considers authoritative for the resolved primary model. */
  primaryProvider?: string;
  /** Provider the registry considers authoritative for the resolved fallback model. */
  fallbackProvider?: string;
}

/**
 * Applies the model registry override to a `{ model, modelFallback }`-shaped
 * options object, before governance/provider resolution. No-op (pass-through)
 * when the registry is disabled or neither field maps to a known family —
 * this preserves the exact current behavior by default.
 *
 * IMPORTANT: this intentionally does NOT write a provider onto `options` —
 * `options.provider` is a single request-wide field that callers reuse for
 * every attempt (primary AND fallback). Primary and fallback models can
 * belong to entirely different families/providers (e.g. a Xiaomi-native
 * primary falling back to a DeepSeek/OpenRouter id), so writing one model's
 * provider there would silently contaminate the other attempt's provider
 * resolution. Callers must instead use `primaryProvider`/`fallbackProvider`
 * only when resolving the provider for that *specific* model.
 */
export async function applyModelRegistryOverride<
  T extends { model?: string; modelFallback?: string },
>(options: T): Promise<ModelRegistryOverrideResult<T>> {
  if (!REGISTRY_ENABLED) return { options };

  const [resolvedModel, resolvedFallback] = await Promise.all([
    resolveActiveModelForDefault(options.model),
    resolveActiveModelForDefault(options.modelFallback),
  ]);

  if (!resolvedModel && !resolvedFallback) return { options };

  return {
    options: {
      ...options,
      ...(resolvedModel ? { model: resolvedModel.modelId } : {}),
      ...(resolvedFallback ? { modelFallback: resolvedFallback.modelId } : {}),
    },
    primaryAlias: resolvedModel?.alias,
    fallbackAlias: resolvedFallback?.alias,
    primaryProvider: resolvedModel?.provider,
    fallbackProvider: resolvedFallback?.provider,
  };
}

/**
 * Normalizes a model id for governance validation. When the registry is
 * enabled, resolves aliases first so governance sees the concrete id. When
 * disabled, returns the input unchanged (existing behavior).
 */
export async function normalizeForGovernance(aliasOrId: string): Promise<string> {
  if (!REGISTRY_ENABLED || !aliasOrId) return aliasOrId;
  // For governance, we want the concrete id, not the alias
  try {
    const resolved = await modelRegistry.resolve(aliasOrId);
    return resolved.modelId;
  } catch (_) {
    // Unknown alias — pass through (governance will reject if not allowed)
    return aliasOrId;
  }
}

/**
 * Records a model failure for auto-rollback tracking. No-op when the registry
 * is disabled.
 */
export async function recordModelFailureForRollback(aliasOrId: string): Promise<void> {
  if (!REGISTRY_ENABLED || !aliasOrId) return;
  try {
    // Lazy import to avoid circular dependency
    const { modelPromoter } = await import('./model-promoter');
    // Only record when the input is a known alias
    const { findFamilyByAlias } = await import('./model-family-rules');
    if (findFamilyByAlias(aliasOrId)) {
      await modelPromoter.recordFailure(aliasOrId);
    }
  } catch (error) {
    logger.debug('[model-registry-bridge] recordModelFailureForRollback skipped', {
      error: error instanceof Error ? error : undefined,
      aliasOrId,
    });
  }
}
