import client from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `vi.resetModules()` re-imports `server/metrics.ts` (and friends) fresh on
// every dynamic import below, which re-registers Prometheus metrics against
// prom-client's process-wide default registry. Clear it first so re-running
// module init doesn't throw "already registered".
function resetModulesAndMetrics(): void {
  vi.resetModules();
  client.register.clear();
}

/**
 * These tests cover CRIT-01 (registry not connected to the inference hot
 * path): they prove that `applyModelRegistryOverride` — the function wired
 * into `openai-ai.ts` generate()/streaming — actually swaps the hardcoded
 * default model id for whatever the registry currently considers "active"
 * for that family's alias (i.e. the real effect of a promotion/rollback),
 * and that a real inference failure feeds the auto-rollback counter via
 * `recordModelFailureForRollback`.
 *
 * The registry's enabled flag is read once at module import time, so each
 * scenario sets `MODEL_REGISTRY_ENABLED` and calls `vi.resetModules()`
 * before re-importing the bridge.
 */
describe('model-registry-bridge', () => {
  const ORIGINAL_ENABLED = process.env.MODEL_REGISTRY_ENABLED;

  afterEach(() => {
    vi.doUnmock('../../server/services/model-registry');
    vi.doUnmock('../../server/services/model-promoter');
    vi.doUnmock('../../server/services/model-family-rules');
    resetModulesAndMetrics();
    if (ORIGINAL_ENABLED === undefined) {
      delete process.env.MODEL_REGISTRY_ENABLED;
    } else {
      process.env.MODEL_REGISTRY_ENABLED = ORIGINAL_ENABLED;
    }
  });

  describe('applyModelRegistryOverride', () => {
    it('passes through unchanged when the registry is disabled', async () => {
      process.env.MODEL_REGISTRY_ENABLED = 'false';
      resetModulesAndMetrics();

      const { applyModelRegistryOverride } =
        await import('../../server/services/model-registry-bridge');
      const result = await applyModelRegistryOverride({
        model: 'mimo-v2.5-pro',
        modelFallback: 'deepseek/deepseek-v4-pro',
      });

      expect(result.options.model).toBe('mimo-v2.5-pro');
      expect(result.options.modelFallback).toBe('deepseek/deepseek-v4-pro');
      expect(result.primaryAlias).toBeUndefined();
      expect(result.fallbackAlias).toBeUndefined();
    });

    it('swaps a hardcoded default model id for the promoted/active model of its family alias', async () => {
      process.env.MODEL_REGISTRY_ENABLED = 'true';
      resetModulesAndMetrics();

      // `mimo-v2.5-pro` is the hardcoded default for the `mimo-pro-latest`
      // family (see config/model-families.json). Simulate a promotion by
      // having the registry resolve the alias to a different active model.
      vi.doMock('../../server/services/model-registry', () => ({
        modelRegistry: {
          resolve: vi.fn(async (aliasOrId: string) => {
            if (aliasOrId === 'mimo-pro-latest') {
              return {
                alias: 'mimo-pro-latest',
                modelId: 'xiaomi/mimo-v3-pro-promoted',
                provider: 'xiaomi',
                fallbackId: 'deepseek/deepseek-v4-pro',
                source: 'database',
                resolvedAt: new Date().toISOString(),
              };
            }
            throw new Error(`unexpected alias resolved in test: ${aliasOrId}`);
          }),
        },
        resolveModelIdSafe: vi.fn(),
        resolveModelWithFallback: vi.fn(),
      }));

      const { applyModelRegistryOverride } =
        await import('../../server/services/model-registry-bridge');
      const result = await applyModelRegistryOverride({ model: 'mimo-v2.5-pro' });

      expect(result.options.model).toBe('xiaomi/mimo-v3-pro-promoted');
      expect(result.primaryAlias).toBe('mimo-pro-latest');
    });

    it('leaves the model unchanged when it is not bound to any known family', async () => {
      process.env.MODEL_REGISTRY_ENABLED = 'true';
      resetModulesAndMetrics();

      const { applyModelRegistryOverride } =
        await import('../../server/services/model-registry-bridge');
      const result = await applyModelRegistryOverride({ model: 'some/unknown-model-id' });

      expect(result.options.model).toBe('some/unknown-model-id');
      expect(result.primaryAlias).toBeUndefined();
    });

    it('resolves the primary AND fallback to the family that actually owns each id, not an unrelated family that merely reuses it as a fallback (reaudit fix)', async () => {
      process.env.MODEL_REGISTRY_ENABLED = 'true';
      resetModulesAndMetrics();

      // `deepseek/deepseek-v4-pro` is the primary id of `deepseek-v4-pro-latest`
      // but is ALSO the fallback of `mimo-pro-latest` and `mistral-medium-latest`.
      // `mistral-medium-3.5` is the primary id of `mistral-medium-latest` but is
      // ALSO the fallback of `mimo-general-latest`, `minimax-m-latest` and
      // `deepseek-v4-pro-latest`. Before the fix, array-order matching on
      // fallbackModelId could resolve either id to a wrong, unrelated family.
      const { applyModelRegistryOverride } =
        await import('../../server/services/model-registry-bridge');
      const result = await applyModelRegistryOverride({
        model: 'deepseek/deepseek-v4-pro',
        modelFallback: 'mistral-medium-3.5',
      });

      expect(result.primaryAlias).toBe('deepseek-v4-pro-latest');
      expect(result.fallbackAlias).toBe('mistral-medium-latest');
      // No promotion in the DB in this test env, so the static fallback keeps
      // the same concrete ids — but resolved through the *correct* family.
      expect(result.options.model).toBe('deepseek/deepseek-v4-pro');
      expect(result.options.modelFallback).toBe('mistral-medium-3.5');
    });

    it('fills in the provider from the registry when the caller did not request one explicitly', async () => {
      process.env.MODEL_REGISTRY_ENABLED = 'true';
      resetModulesAndMetrics();

      const { applyModelRegistryOverride } =
        await import('../../server/services/model-registry-bridge');
      const result = await applyModelRegistryOverride({ model: 'deepseek/deepseek-v4-pro' });

      // The bridge intentionally does NOT write `provider` onto `options` —
      // `options.provider` is a single request-wide field reused for both
      // primary and fallback attempts, and the two can belong to different
      // providers. Callers must read `primaryProvider`/`fallbackProvider`
      // when resolving the provider for each attempt specifically.
      expect(result.options.provider).toBeUndefined();
      expect(result.primaryProvider).toBe('tencent');
    });

    it('does not override an explicitly requested provider', async () => {
      process.env.MODEL_REGISTRY_ENABLED = 'true';
      resetModulesAndMetrics();

      const { applyModelRegistryOverride } =
        await import('../../server/services/model-registry-bridge');
      const result = await applyModelRegistryOverride({
        model: 'deepseek/deepseek-v4-pro',
        provider: 'openai',
      });

      expect(result.options.provider).toBe('openai');
    });
  });

  describe('recordModelFailureForRollback', () => {
    it('is a no-op when the registry is disabled', async () => {
      process.env.MODEL_REGISTRY_ENABLED = 'false';
      resetModulesAndMetrics();

      const recordFailure = vi.fn();
      vi.doMock('../../server/services/model-promoter', () => ({
        modelPromoter: { recordFailure },
      }));

      const { recordModelFailureForRollback } =
        await import('../../server/services/model-registry-bridge');
      await recordModelFailureForRollback('mimo-pro-latest');

      expect(recordFailure).not.toHaveBeenCalled();
    });

    it('feeds a real inference failure into the auto-rollback counter for a known alias', async () => {
      process.env.MODEL_REGISTRY_ENABLED = 'true';
      resetModulesAndMetrics();

      const recordFailure = vi.fn(async () => ({ rolledBack: false }));
      vi.doMock('../../server/services/model-promoter', () => ({
        modelPromoter: { recordFailure },
      }));

      const { recordModelFailureForRollback } =
        await import('../../server/services/model-registry-bridge');
      await recordModelFailureForRollback('mimo-pro-latest');

      expect(recordFailure).toHaveBeenCalledWith('mimo-pro-latest');
    });

    it('does not call recordFailure for an id that is not a known alias', async () => {
      process.env.MODEL_REGISTRY_ENABLED = 'true';
      resetModulesAndMetrics();

      const recordFailure = vi.fn();
      vi.doMock('../../server/services/model-promoter', () => ({
        modelPromoter: { recordFailure },
      }));

      const { recordModelFailureForRollback } =
        await import('../../server/services/model-registry-bridge');
      await recordModelFailureForRollback('some/unknown-model-id');

      expect(recordFailure).not.toHaveBeenCalled();
    });
  });
});
