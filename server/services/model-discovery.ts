/**
 * ModelDiscovery — discovers available models from provider catalogs,
 * normalizes them, applies family rules, and registers candidates.
 *
 * Design principles (security rules 3.1–3.5):
 *  - Never blocks startup or inference.
 *  - One catalog fetch per provider per cycle.
 *  - Validates response schema before trusting it.
 *  - Applies family include/exclude rules to filter candidates.
 *  - Registers candidates with evidence; does NOT promote by default.
 *  - Does not persist secrets or full raw responses.
 *
 * Providers supported:
 *  - OpenRouter: GET https://openrouter.ai/api/v1/models (public, no auth)
 *  - Mistral: GET https://api.mistral.ai/v1/models (Bearer auth, optional)
 *  - Xiaomi: GET https://token-plan-sgp.xiaomimimo.com/v1/models (Bearer auth, optional)
 */

import { eq, and } from 'drizzle-orm';
import { db as defaultDb, type DbClient } from '../db';
import { modelCandidates, modelAliases } from '@shared/schema-unified';
import type { ModelCandidate } from '@shared/schema';
import { logger } from '../utils/logger';
import {
  loadModelFamiliesConfig,
  isEligibleCandidate,
  type ModelFamily,
} from './model-family-rules';
import { compareModels } from './model-version-comparator';
import { asWriter, asReader } from './drizzle-helpers';
import {
  modelDiscoveryRunTotal,
  modelDiscoveryCandidateTotal,
  modelDiscoveryFailureTotal,
  modelProviderCatalogFetchTotal,
  modelProviderCatalogFetchFailureTotal,
} from '../metrics/model-registry';

// ── Normalized model interface ──────────────────────────────────────────────

export interface DiscoveredModel {
  id: string;
  provider: string;
  name?: string;
  createdAt?: Date;
  contextLength?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  pricing?: {
    prompt?: number;
    completion?: number;
    currency?: string;
  };
  rawMetadata?: Record<string, unknown>;
}

export interface DiscoveryResult {
  provider: string;
  fetched: boolean;
  modelCount: number;
  candidatesRegistered: number;
  error?: string;
}

export interface DiscoveryCycleResult {
  results: DiscoveryResult[];
  totalCandidates: number;
  durationMs: number;
}

// ── Provider fetchers ───────────────────────────────────────────────────────

const OPENROUTER_CATALOG_URL = 'https://openrouter.ai/api/v1/models';
const MISTRAL_CATALOG_URL = 'https://api.mistral.ai/v1/models';
// Pick the base URL BEFORE appending `/models`. The previous form
// `env?.replace(...) + '/models' || default` bound `+` tighter than `||`, so an
// unset XIAOMI_BASE_URL produced the truthy string 'undefined/models' and the
// default was never used (HIGH-04).
const XIAOMI_CATALOG_BASE = (
  process.env.XIAOMI_BASE_URL?.replace(/\/$/, '') || 'https://token-plan-sgp.xiaomimimo.com/v1'
).replace(/\/$/, '');
const XIAOMI_CATALOG_URL = `${XIAOMI_CATALOG_BASE}/models`;

const FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseNumberish(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Fetches and validates the OpenRouter catalog. Reuses the same endpoint as
 * openrouter-pricing.ts but with its own validation focused on discovery
 * (capabilities + modality), not just pricing.
 */
export async function fetchOpenRouterCatalog(): Promise<DiscoveredModel[]> {
  const response = await fetchWithTimeout(OPENROUTER_CATALOG_URL);
  if (!response.ok) {
    throw new Error(`OpenRouter catalog HTTP ${response.status}`);
  }
  const data = (await response.json()) as { data?: unknown[] };

  if (!data || !Array.isArray(data.data)) {
    throw new Error('OpenRouter catalog: invalid response shape (data array missing)');
  }

  const models: DiscoveredModel[] = [];
  for (const entry of data.data) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = e.id;
    if (typeof id !== 'string' || !id) continue;

    const arch = e.architecture as Record<string, unknown> | undefined;
    const pricing = e.pricing as Record<string, unknown> | undefined;

    models.push({
      id,
      provider: 'openrouter',
      name: typeof e.name === 'string' ? e.name : undefined,
      contextLength: parseNumberish(e.context_length),
      inputModalities: Array.isArray(arch?.input_modalities)
        ? (arch.input_modalities as unknown[]).filter((m): m is string => typeof m === 'string')
        : undefined,
      outputModalities: Array.isArray(arch?.output_modalities)
        ? (arch.output_modalities as unknown[]).filter((m): m is string => typeof m === 'string')
        : undefined,
      pricing: pricing
        ? {
            prompt: parseNumberish(pricing.prompt),
            completion: parseNumberish(pricing.completion),
            currency: 'USD',
          }
        : undefined,
      // Do NOT persist full rawMetadata to avoid leaking sensitive fields.
      rawMetadata: { source: 'openrouter' },
    });
  }

  return models;
}

/**
 * Fetches and validates the Mistral catalog. Requires MISTRAL_API_KEY but
 * continues gracefully (returns empty) when the key is absent.
 */
export async function fetchMistralCatalog(): Promise<DiscoveredModel[]> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    logger.info('[model-discovery] Mistral API key not configured, skipping catalog fetch');
    return [];
  }

  const response = await fetchWithTimeout(MISTRAL_CATALOG_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error('Mistral catalog: authentication failed');
  }
  if (!response.ok) {
    throw new Error(`Mistral catalog HTTP ${response.status}`);
  }

  const data = (await response.json()) as { data?: unknown[] };

  if (!data || !Array.isArray(data.data)) {
    throw new Error('Mistral catalog: invalid response shape');
  }

  const models: DiscoveredModel[] = [];
  for (const entry of data.data) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = e.id;
    if (typeof id !== 'string' || !id) continue;

    const created = parseNumberish(e.created);
    models.push({
      id,
      provider: 'mistral',
      name: typeof e.name === 'string' ? e.name : undefined,
      createdAt: created ? new Date(created * 1000) : undefined,
      contextLength: parseNumberish(e.context_length),
      inputModalities: ['text'], // Mistral models are text-only by default
      outputModalities: ['text'],
      rawMetadata: { source: 'mistral' },
    });
  }

  return models;
}

/**
 * Fetches and validates the Xiaomi MiMo catalog. Treated as an OPTIONAL
 * capability — when the key is absent or the endpoint is unreachable, returns
 * empty and logs clearly. Does NOT invent fields.
 */
export async function fetchXiaomiCatalog(): Promise<DiscoveredModel[]> {
  const apiKey = process.env.XIAOMI_API_KEY;
  if (!apiKey) {
    logger.info('[model-discovery] Xiaomi API key not configured, skipping catalog fetch');
    return [];
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(XIAOMI_CATALOG_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });
  } catch (error) {
    // Xiaomi endpoint documentation is limited — treat as optional/unavailable.
    logger.info('[model-discovery] Xiaomi catalog fetch failed (optional capability)', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  if (response.status === 401 || response.status === 403) {
    logger.warn('[model-discovery] Xiaomi catalog: authentication failed');
    return [];
  }
  if (!response.ok) {
    logger.info('[model-discovery] Xiaomi catalog: HTTP ' + response.status);
    return [];
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (_) {
    logger.warn('[model-discovery] Xiaomi catalog: invalid JSON response');
    return [];
  }

  // Xiaomi schema is not publicly documented — validate minimally.
  // Accept either { data: [...] } or [ ... ] shapes.
  let entries: unknown[];
  if (Array.isArray(data)) {
    entries = data;
  } else if (
    data &&
    typeof data === 'object' &&
    Array.isArray((data as Record<string, unknown>).data)
  ) {
    entries = (data as Record<string, unknown>).data as unknown[];
  } else {
    logger.warn('[model-discovery] Xiaomi catalog: unrecognized response shape');
    return [];
  }

  const models: DiscoveredModel[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = e.id;
    if (typeof id !== 'string' || !id) continue;

    models.push({
      id,
      provider: 'xiaomi',
      name: typeof e.name === 'string' ? e.name : undefined,
      contextLength: parseNumberish(e.context_length),
      inputModalities: Array.isArray(e.input_modalities)
        ? (e.input_modalities as string[]).filter((m) => typeof m === 'string')
        : ['text'],
      outputModalities: Array.isArray(e.output_modalities)
        ? (e.output_modalities as string[]).filter((m) => typeof m === 'string')
        : undefined,
      rawMetadata: { source: 'xiaomi' },
    });
  }

  return models;
}

// ── Discovery engine ───────────────────────────────────────────────────────

export class ModelDiscovery {
  constructor(private readonly database: DbClient = defaultDb) {}

  /**
   * Runs a single discovery cycle:
   *  1. fetch each provider catalog once;
   *  2. normalize models;
   *  3. apply family rules;
   *  4. register eligible candidates (without promoting).
   */
  async runCycle(): Promise<DiscoveryCycleResult> {
    const start = Date.now();
    const families = loadModelFamiliesConfig().families;

    // Group families by provider to fetch each catalog once
    const familiesByProvider = new Map<string, ModelFamily[]>();
    for (const family of families) {
      const list = familiesByProvider.get(family.provider) ?? [];
      list.push(family);
      familiesByProvider.set(family.provider, list);
    }

    const results: DiscoveryResult[] = [];
    let totalCandidates = 0;

    for (const [provider, providerFamilies] of familiesByProvider) {
      const result = await this.discoverProvider(provider, providerFamilies);
      results.push(result);
      totalCandidates += result.candidatesRegistered;
    }

    const durationMs = Date.now() - start;
    modelDiscoveryRunTotal.inc({ result: results.some((r) => r.error) ? 'partial' : 'success' });

    logger.info('[model-discovery] Cycle complete', {
      context: {
        totalCandidates,
        durationMs,
        providers: results.map((r) => r.provider).join(','),
      },
    });

    return { results, totalCandidates, durationMs };
  }

  private async discoverProvider(
    provider: string,
    families: ModelFamily[],
  ): Promise<DiscoveryResult> {
    let catalog: DiscoveredModel[] = [];
    let fetchError: string | undefined;

    try {
      catalog = await this.fetchProviderCatalog(provider);
      modelProviderCatalogFetchTotal.inc({ provider, result: 'success' });
    } catch (error) {
      fetchError = error instanceof Error ? error.message : String(error);
      modelProviderCatalogFetchTotal.inc({ provider, result: 'failure' });
      modelProviderCatalogFetchFailureTotal.inc({ provider, reason: 'fetch-error' });
      modelDiscoveryFailureTotal.inc({ provider, reason: 'catalog-fetch' });
      logger.warn('[model-discovery] Provider catalog fetch failed', {
        context: { provider, error: fetchError },
      });
    }

    if (catalog.length === 0) {
      return {
        provider,
        fetched: !fetchError,
        modelCount: 0,
        candidatesRegistered: 0,
        error: fetchError,
      };
    }

    let candidatesRegistered = 0;
    for (const family of families) {
      candidatesRegistered += await this.registerCandidatesForFamily(family, catalog);
    }

    return {
      provider,
      fetched: true,
      modelCount: catalog.length,
      candidatesRegistered,
      error: fetchError,
    };
  }

  private async fetchProviderCatalog(provider: string): Promise<DiscoveredModel[]> {
    switch (provider) {
      case 'openrouter':
        return fetchOpenRouterCatalog();
      case 'tencent':
        // Tencent TokenHub reuses the same OpenAI-compatible model IDs, so
        // candidate discovery is performed against the OpenRouter catalog.
        // Provider is rewritten to 'tencent' so family matching works.
        return fetchOpenRouterCatalog().then((models) =>
          models.map((model) => ({ ...model, provider: 'tencent' as const })),
        );
      case 'mistral':
        return fetchMistralCatalog();
      case 'xiaomi':
        return fetchXiaomiCatalog();
      default:
        logger.warn(`[model-discovery] Unknown provider: ${provider}`);
        return [];
    }
  }

  private async registerCandidatesForFamily(
    family: ModelFamily,
    catalog: DiscoveredModel[],
  ): Promise<number> {
    // Get the current active model id for this family
    const currentModelId = await this.getCurrentModelId(family);
    if (!currentModelId) {
      logger.warn('[model-discovery] No current model for family, skipping', {
        context: { alias: family.alias },
      });
      return 0;
    }

    let registered = 0;
    for (const model of catalog) {
      // Only consider models from the homologated provider
      if (model.provider !== family.provider) continue;

      const eligibility = isEligibleCandidate(family, model.id, {
        contextLength: model.contextLength,
        inputModalities: model.inputModalities,
        pricing: model.pricing,
      });

      if (!eligibility.eligible) continue;

      // Skip if it's the same as the current model
      if (model.id.toLowerCase() === currentModelId.toLowerCase()) continue;

      // Compare versions to decide if it's a newer candidate
      const comparison = compareModels({
        family,
        currentModelId,
        candidateModelId: model.id,
        candidateCreatedAt: model.createdAt,
      });

      // Only register candidates that are newer or incomparable (let human decide)
      if (comparison.winner === 'current') continue;

      // Check for duplicate candidate
      const isDuplicate = await this.isDuplicateCandidate(family.alias, model.id);
      if (isDuplicate) continue;

      await this.registerCandidate(family, currentModelId, model, comparison);
      registered++;

      modelDiscoveryCandidateTotal.inc({
        provider: family.provider,
        family: family.family,
        status: 'discovered',
      });
    }

    return registered;
  }

  private async getCurrentModelId(family: ModelFamily): Promise<string | null> {
    try {
      const rows = (await asReader(this.database)
        .select()
        .from(modelAliases)
        .where(eq(modelAliases.alias, family.alias))
        .limit(1)) as unknown as unknown[];

      if (rows.length > 0) {
        return (rows[0] as ModelCandidate & { activeModelId: string }).activeModelId;
      }
    } catch (_) {
      // fall through to config
    }
    return family.initialModelId;
  }

  private async isDuplicateCandidate(alias: string, candidateModelId: string): Promise<boolean> {
    try {
      const rows = (await asReader(this.database)
        .select()
        .from(modelCandidates)
        .where(
          and(
            eq(modelCandidates.alias, alias),
            eq(modelCandidates.candidateModelId, candidateModelId),
          ),
        )
        .limit(1)) as unknown as unknown[];
      return rows.length > 0;
    } catch (_) {
      return false;
    }
  }

  private async registerCandidate(
    family: ModelFamily,
    currentModelId: string,
    model: DiscoveredModel,
    comparison: { winner: string; reason: string },
  ): Promise<void> {
    const evidence = {
      comparisonWinner: comparison.winner,
      comparisonReason: comparison.reason,
      contextLength: model.contextLength,
      inputModalities: model.inputModalities,
      outputModalities: model.outputModalities,
      discoveredAt: new Date().toISOString(),
    };

    const capabilities = {
      contextLength: model.contextLength,
      inputModalities: model.inputModalities,
      outputModalities: model.outputModalities,
      pricing: model.pricing,
    };

    try {
      await asWriter(this.database)
        .insert(modelCandidates)
        .values({
          alias: family.alias,
          family: family.family,
          provider: family.provider,
          currentModelId,
          candidateModelId: model.id,
          candidateVersion: model.id,
          status: 'discovered',
          selectionReason: `${comparison.winner}: ${comparison.reason}`,
          evidence,
          capabilities,
        });
    } catch (error) {
      // Duplicate insert (already registered) — ignore
      const msg = error instanceof Error ? error.message.toLowerCase() : '';
      if (!msg.includes('unique') && !msg.includes('duplicate')) {
        logger.warn('[model-discovery] Failed to register candidate', {
          context: { alias: family.alias, candidate: model.id },
          error: error instanceof Error ? error : undefined,
        });
      }
    }
  }

  /**
   * Lists candidates optionally filtered by alias or status.
   *
   * Drizzle's `.where()` REPLACES the previous condition rather than
   * combining it, so we must accumulate predicates and apply them in a
   * single `and(...)` call — otherwise the second filter silently drops
   * the first.
   */
  async listCandidates(filter?: { alias?: string; status?: string }): Promise<ModelCandidate[]> {
    const reader = asReader(this.database);
    const predicates: ReturnType<typeof eq>[] = [];
    if (filter?.alias) {
      predicates.push(eq(modelCandidates.alias, filter.alias));
    }
    if (filter?.status) {
      // Cast status to the enum type to satisfy the union column type
      predicates.push(eq(modelCandidates.status, filter.status as never));
    }
    const query = reader.select().from(modelCandidates);
    const filtered = predicates.length > 0 ? query.where(and(...predicates)) : query;
    return (await filtered) as unknown as ModelCandidate[];
  }
}

export const modelDiscovery = new ModelDiscovery();
