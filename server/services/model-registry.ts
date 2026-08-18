/**
 * ModelRegistry — central registry for resolving stable aliases to concrete
 * model ids, with caching, persistence, and fallback.
 *
 * Resolution flow (security rule 3.5 — never blocks startup):
 *   Alias or id received
 *     → memory cache (Layer 1)
 *     → persisted alias (Layer 2, database)
 *     → static fallback from model-families.json config
 *     → existing fallback mechanism (caller handles)
 *
 * The registry accepts:
 *   - known aliases (e.g. `mimo-pro-latest`);
 *   - concrete model ids permitted by governance;
 *   - legacy Mistral aliases (normalized via the existing alias map);
 *   - ids from agent YAML or env vars.
 *
 * It NEVER silently turns an unknown string into a default model — it returns
 * a typed `UnknownModelAliasError` instead, so callers can decide.
 */

import { eq } from 'drizzle-orm';
import { db as defaultDb, type DbClient } from '../db';
import { modelAliases, modelHistory } from '@shared/schema-unified';
import type { ModelAlias, ModelHistoryAction } from '@shared/schema';
import { logger } from '../utils/logger';
import {
  findFamilyByAlias,
  findFamilyByModelId,
  loadModelFamiliesConfig,
  type ModelFamily,
} from './model-family-rules';
import { UnknownModelAliasError } from './model-registry-errors';
import { asWriter, asReader } from './drizzle-helpers';
import {
  modelRegistryResolveTotal,
  modelRegistryResolveDurationMs,
  modelRegistryCacheHitTotal,
  modelRegistryCacheMissTotal,
} from '../metrics/model-registry';

export interface ResolvedModel {
  alias: string;
  modelId: string;
  provider: string;
  fallbackId?: string;
  source: 'memory-cache' | 'database' | 'static-fallback';
  resolvedAt: string;
}

export interface ModelAliasInfo {
  alias: string;
  family: string;
  provider: string;
  activeModelId: string;
  fallbackModelId?: string;
  status: string;
  source: string;
  createdAt?: string;
  updatedAt?: string;
  lastValidatedAt?: string;
}

interface CacheEntry {
  resolved: ResolvedModel;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 14_400_000; // 4 hours

function parseCacheTtl(): number {
  const raw = parseInt(process.env.MODEL_REGISTRY_CACHE_TTL_MS || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CACHE_TTL_MS;
  // Clamp to [60s, 7d] to avoid misconfiguration
  return Math.min(Math.max(raw, 60_000), 7 * 86_400_000);
}

export class ModelRegistry {
  private cache = new Map<string, CacheEntry>();
  private cacheTtlMs = parseCacheTtl();
  private seeded = false;

  constructor(private readonly database: DbClient = defaultDb) {}

  /**
   * Resolves an alias or concrete model id to a ResolvedModel.
   *
   * Accepts:
   *  - known aliases → active model id + provider
   *  - concrete model ids → resolved to their family/alias when known, or
   *    returned as-is with the provider inferred from the id
   *  - legacy Mistral aliases (normalized via the family config)
   *
   * Throws UnknownModelAliasError when the input is neither a known alias nor
   * a permitted concrete id.
   */
  async resolve(aliasOrModelId: string): Promise<ResolvedModel> {
    if (!aliasOrModelId) {
      throw new UnknownModelAliasError(aliasOrModelId);
    }

    const normalized = aliasOrModelId.trim();
    const start = Date.now();

    // Layer 1: memory cache
    const cached = this.cache.get(normalized.toLowerCase());
    if (cached && cached.expiresAt > Date.now()) {
      modelRegistryCacheHitTotal.inc();
      modelRegistryResolveTotal.inc({ source: 'memory-cache', result: 'hit' });
      modelRegistryResolveDurationMs.labels('memory-cache').observe(Date.now() - start);
      return { ...cached.resolved, source: 'memory-cache', resolvedAt: new Date().toISOString() };
    }

    modelRegistryCacheMissTotal.inc();

    // Layer 2: database (persisted aliases)
    try {
      const persisted = await this.lookupPersistedAlias(normalized);
      if (persisted) {
        const resolved = this.toResolved(persisted, 'database');
        this.setCache(normalized, resolved);
        modelRegistryResolveTotal.inc({ source: 'database', result: 'hit' });
        modelRegistryResolveDurationMs.labels('database').observe(Date.now() - start);
        return resolved;
      }
    } catch (error) {
      // Database errors are logged but never block resolution — fall through
      // to static fallback. Security rule 3.5.
      logger.warn('[model-registry] Database lookup failed, using static fallback', {
        error: error instanceof Error ? error : undefined,
        aliasOrModelId: normalized,
      });
    }

    // Layer 3: static fallback from config
    const family = findFamilyByAlias(normalized);
    if (family) {
      const resolved = this.toResolvedFromFamily(family, normalized);
      this.setCache(normalized, resolved);
      modelRegistryResolveTotal.inc({ source: 'static-fallback', result: 'hit' });
      modelRegistryResolveDurationMs.labels('static-fallback').observe(Date.now() - start);
      return resolved;
    }

    // Maybe it's a concrete model id that belongs to a known family
    const familyByModelId = findFamilyByModelId(normalized);
    if (familyByModelId) {
      const resolved = this.toResolvedFromFamily(familyByModelId, familyByModelId.alias);
      resolved.modelId = normalized; // concrete id wins
      this.setCache(normalized, resolved);
      modelRegistryResolveTotal.inc({ source: 'static-fallback', result: 'hit' });
      modelRegistryResolveDurationMs.labels('static-fallback').observe(Date.now() - start);
      return resolved;
    }

    // Unknown — do NOT silently default. Return a typed error.
    modelRegistryResolveTotal.inc({ source: 'unknown', result: 'miss' });
    modelRegistryResolveDurationMs.labels('unknown').observe(Date.now() - start);
    throw new UnknownModelAliasError(normalized);
  }

  /**
   * Lists all known aliases (from config + persisted).
   */
  async listAliases(): Promise<ModelAliasInfo[]> {
    const configFamilies = loadModelFamiliesConfig().families;
    const persisted = await this.listPersistedAliases().catch(() => [] as ModelAlias[]);

    const persistedByAlias = new Map(persisted.map((p) => [p.alias, p]));
    const result: ModelAliasInfo[] = [];

    for (const family of configFamilies) {
      const dbRow = persistedByAlias.get(family.alias);
      if (dbRow) {
        result.push(this.toAliasInfo(dbRow));
      } else {
        result.push({
          alias: family.alias,
          family: family.family,
          provider: family.provider,
          activeModelId: family.initialModelId,
          fallbackModelId: family.fallbackModelId,
          status: 'active',
          source: 'static-fallback',
        });
      }
    }

    // Include persisted aliases not in config (e.g. removed families)
    for (const row of persisted) {
      if (!configFamilies.some((f) => f.alias === row.alias)) {
        result.push(this.toAliasInfo(row));
      }
    }

    return result;
  }

  /**
   * Invalidates the cache. If an alias is provided, only that entry is
   * invalidated; otherwise the entire cache is cleared.
   */
  async invalidate(alias?: string): Promise<void> {
    if (alias) {
      this.cache.delete(alias.toLowerCase());
      logger.info('[model-registry] Cache invalidated', { context: { alias } });
    } else {
      this.cache.clear();
      logger.info('[model-registry] Full cache invalidated');
    }
  }

  /**
   * Seeds the database with the initial aliases from config if they don't
   * already exist. Idempotent — safe to call on every startup. Never throws
   * (security rule 3.5).
   */
  async seedIfNeeded(): Promise<void> {
    if (this.seeded) return;
    this.seeded = true;

    try {
      const families = loadModelFamiliesConfig().families;
      for (const family of families) {
        await this.seedAlias(family);
      }
    } catch (error) {
      logger.warn('[model-registry] Seeding failed (non-blocking)', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  private async seedAlias(family: ModelFamily): Promise<void> {
    try {
      const existing = await this.lookupPersistedAlias(family.alias);
      if (existing) return;

      const insertResult = asWriter(this.database)
        .insert(modelAliases)
        .values({
          alias: family.alias,
          family: family.family,
          provider: family.provider,
          activeModelId: family.initialModelId,
          fallbackModelId: family.fallbackModelId ?? null,
          status: 'active',
          source: 'static-fallback',
        });
      // onConflictDoNothing is available in modern Drizzle; fall back to
      // catching the duplicate-key error when not available.
      if (typeof insertResult.onConflictDoNothing === 'function') {
        await insertResult.onConflictDoNothing();
      } else {
        await insertResult;
      }

      await asWriter(this.database)
        .insert(modelHistory)
        .values({
          alias: family.alias,
          previousModelId: null,
          newModelId: family.initialModelId,
          action: 'seeded' as ModelHistoryAction,
          reason: 'Initial seed from model-families.json',
          triggeredBy: 'system',
          metadata: { source: 'config', configVersion: loadModelFamiliesConfig().version },
        });
    } catch (error) {
      // onConflictDoNothing may not be available on all Drizzle versions for
      // both dialects — fall back to a no-op when the alias already exists.
      if (this.isDuplicateError(error)) return;
      throw error;
    }
  }

  private isDuplicateError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message.toLowerCase() : '';
    return msg.includes('unique') || msg.includes('duplicate') || msg.includes('constraint');
  }

  private async lookupPersistedAlias(alias: string): Promise<ModelAlias | null> {
    const rows = (await asReader(this.database)
      .select()
      .from(modelAliases)
      .where(eq(modelAliases.alias, alias))
      .limit(1)) as unknown as unknown[];
    return (rows[0] as ModelAlias | undefined) ?? null;
  }

  private async listPersistedAliases(): Promise<ModelAlias[]> {
    return (await asReader(this.database).select().from(modelAliases)) as unknown as ModelAlias[];
  }

  private toResolved(row: ModelAlias, source: ResolvedModel['source']): ResolvedModel {
    return {
      alias: row.alias,
      modelId: row.activeModelId,
      provider: row.provider,
      fallbackId: row.fallbackModelId ?? undefined,
      source,
      resolvedAt: new Date().toISOString(),
    };
  }

  private toResolvedFromFamily(family: ModelFamily, alias: string): ResolvedModel {
    return {
      alias,
      modelId: family.initialModelId,
      provider: family.provider,
      fallbackId: family.fallbackModelId,
      source: 'static-fallback',
      resolvedAt: new Date().toISOString(),
    };
  }

  private toAliasInfo(row: ModelAlias): ModelAliasInfo {
    return {
      alias: row.alias,
      family: row.family,
      provider: row.provider,
      activeModelId: row.activeModelId,
      fallbackModelId: row.fallbackModelId ?? undefined,
      status: row.status,
      source: 'database', // reading from DB → source is database
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
      lastValidatedAt:
        row.lastValidatedAt instanceof Date
          ? row.lastValidatedAt.toISOString()
          : (row.lastValidatedAt ?? undefined),
    };
  }

  private setCache(key: string, resolved: ResolvedModel): void {
    this.cache.set(key.toLowerCase(), {
      resolved,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
  }

  /** Test helper: reset cache and seeded state. */
  reset(): void {
    this.cache.clear();
    this.seeded = false;
    this.cacheTtlMs = parseCacheTtl();
  }
}

export const modelRegistry = new ModelRegistry();

/**
 * Convenience helper: resolves an alias or id, returning the concrete model id
 * string. When the registry is unavailable or the alias is unknown, returns
 * the input unchanged (so the existing fallback path in llm-model-router can
 * take over). This preserves backward compatibility during migration.
 */
export async function resolveModelIdSafe(aliasOrId: string): Promise<string> {
  try {
    const resolved = await modelRegistry.resolve(aliasOrId);
    return resolved.modelId;
  } catch (error) {
    if (error instanceof UnknownModelAliasError) {
      return aliasOrId; // pass-through to existing resolution
    }
    // Registry unavailable — log and pass-through
    logger.warn('[model-registry] resolveModelIdSafe pass-through', {
      error: error instanceof Error ? error : undefined,
      aliasOrId,
    });
    return aliasOrId;
  }
}

/**
 * Convenience helper: resolves an alias or id, returning the concrete model id
 * AND the fallback. When unavailable, returns the input as both model and
 * fallback (so the caller's own fallback still works).
 */
export async function resolveModelWithFallback(
  aliasOrId: string,
): Promise<{ modelId: string; fallbackId?: string; provider?: string; alias?: string }> {
  try {
    const resolved = await modelRegistry.resolve(aliasOrId);
    return {
      modelId: resolved.modelId,
      fallbackId: resolved.fallbackId,
      provider: resolved.provider,
      alias: resolved.alias,
    };
  } catch (_) {
    return { modelId: aliasOrId };
  }
}
