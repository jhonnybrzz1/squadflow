import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  estimateCost,
  estimateCostUsd,
  getModelPricing,
} from '../../server/services/ai-usage-tracker';
import { clearPricingCache } from '../../server/services/openrouter-pricing';
import { logger } from '../../server/utils/logger';

describe('model pricing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearPricingCache();
  });

  it('uses Mistral list pricing instead of treating a free-tier entitlement as zero cost', () => {
    // mistral-medium-3.5 is the canonical current Mistral model ($1.5/$7.5)
    expect(getModelPricing('mistral-medium-3.5')).toEqual({
      inputUsdPer1M: 1.5,
      outputUsdPer1M: 7.5,
    });
    expect(estimateCostUsd('mistral-medium-3.5', 1_000_000, 1_000_000)).toBe(9);
    // Legacy mistral-large-latest now aliases to mistral-medium-3.5 pricing
    expect(getModelPricing('mistral-large-latest')).toEqual({
      inputUsdPer1M: 1.5,
      outputUsdPer1M: 7.5,
    });
  });

  it('returns an auditable dynamic estimate and leaves billing and credits unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'deepseek/deepseek-v4-pro',
                pricing: { prompt: '0.000001', completion: '0.000002' },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const estimate = await estimateCost('deepseek/deepseek-v4-pro', 1_000_000, 1_000_000);

    expect(estimate).toMatchObject({
      listCostUsd: 3,
      billedCostUsd: null,
      creditAppliedUsd: null,
      pricingSource: 'dynamic',
      isEstimated: true,
    });
  });

  it('resolves provider-prefixed OpenRouter model IDs against the dynamic catalog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'qwen/qwen3-embedding-8b',
                pricing: { prompt: '0.00000001', completion: '0' },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(
      estimateCost('openrouter:qwen/qwen3-embedding-8b', 1_000_000, 0),
    ).resolves.toMatchObject({ listCostUsd: 0.01, pricingSource: 'dynamic' });
  });

  it('ignores malformed dynamic prices instead of converting them to zero', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'unknown/model',
                pricing: { prompt: null, completion: 'invalid' },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(estimateCost('unknown/model', 100, 100)).resolves.toMatchObject({
      listCostUsd: null,
      pricingSource: 'unknown',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Ignoring invalid pricing for OpenRouter model unknown/model',
    );
  });
});
