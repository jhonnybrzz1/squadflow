import { toOpenRouterModel } from './bedrock-openrouter-bridge';
import { logger } from '../utils/logger';

interface PricingInfo {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
}

function parsePricePerToken(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : null;
}

let pricingCache: Map<string, PricingInfo> = new Map();
let cacheExpiry: number = 0;
let cacheUpdatedAt: string | null = null;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in ms

async function fetchOpenRouterPricing(): Promise<Map<string, PricingInfo> | null> {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models');
    if (!response.ok) {
      throw new Error(`OpenRouter pricing fetch failed: HTTP ${response.status}`);
    }
    const data = await response.json();
    if (!data || !Array.isArray(data.data)) {
      throw new Error('Invalid OpenRouter response format');
    }

    const newCache = new Map<string, PricingInfo>();
    for (const modelInfo of data.data) {
      if (modelInfo.id && modelInfo.pricing) {
        // OpenRouter returns pricing per token, so multiply by 1M
        const inputUsdPer1M = parsePricePerToken(modelInfo.pricing.prompt);
        const outputUsdPer1M = parsePricePerToken(modelInfo.pricing.completion);

        if (inputUsdPer1M !== null && outputUsdPer1M !== null) {
          newCache.set(modelInfo.id.toLowerCase(), { inputUsdPer1M, outputUsdPer1M });
        } else {
          logger.warn(`Ignoring invalid pricing for OpenRouter model ${modelInfo.id}`);
        }
      }
    }
    logger.info(`Successfully fetched and parsed ${newCache.size} model prices from OpenRouter.`);
    return newCache;
  } catch (error) {
    logger.warn('Failed to fetch pricing from OpenRouter, falling back to static pricing', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Public function to clear the cache. Useful for unit testing.
 */
export function clearPricingCache(): void {
  pricingCache.clear();
  cacheExpiry = 0;
  cacheUpdatedAt = null;
}

/**
 * Returns dynamic pricing info for a model with 24h lazy caching.
 */
export async function getCachedPricing(model: string): Promise<PricingInfo | null> {
  const result = await getCachedPricingWithMetadata(model);
  return result?.pricing ?? null;
}

export async function getCachedPricingWithMetadata(
  model: string,
): Promise<{ pricing: PricingInfo; pricingUpdatedAt: string } | null> {
  const withoutProviderPrefix = model.toLowerCase().startsWith('openrouter:')
    ? model.slice('openrouter:'.length)
    : model;
  const normalizedModel = toOpenRouterModel(withoutProviderPrefix).toLowerCase();

  const now = Date.now();
  if (pricingCache.size === 0 || now > cacheExpiry) {
    const fetched = await fetchOpenRouterPricing();
    if (fetched) {
      pricingCache = fetched;
      cacheExpiry = now + CACHE_TTL;
      cacheUpdatedAt = new Date(now).toISOString();
    }
  }

  const pricing = pricingCache.get(normalizedModel);
  return pricing && cacheUpdatedAt ? { pricing, pricingUpdatedAt: cacheUpdatedAt } : null;
}
