import { describe, expect, it } from 'vitest';

import { loadModelFamiliesConfig } from '../../server/services/model-family-rules';
import { resolveProvider } from '../../server/services/llm-model-router';

/**
 * `config/model-families.json` declares the provider homologated to serve each
 * family. That value is NOT documentation: the registry hands it to
 * `resolveProvider` as the `requestedProvider` argument (see
 * `model-registry-bridge.ts` → `openai-ai.ts`), and `resolveProvider` returns a
 * requested provider verbatim, ahead of its own model-id rules.
 *
 * So whenever the JSON disagrees with the router, the JSON silently wins on the
 * registry path while the router wins everywhere else — the same model gets
 * sent to two different providers depending on the call path. That is exactly
 * the drift that sent the DeepSeek families to OpenRouter after they had been
 * homologated to Tencent TokenHub.
 *
 * This test pins both sources to the same answer.
 */
describe('model-families.json ↔ llm-model-router provider consistency', () => {
  const { families } = loadModelFamiliesConfig();

  it('declares at least one family (guards against an empty/misparsed config)', () => {
    expect(families.length).toBeGreaterThan(0);
  });

  it.each(families.map((family) => [family.alias, family.initialModelId, family.provider]))(
    '%s (%s) is declared as the provider the router already resolves',
    (_alias, initialModelId, declaredProvider) => {
      expect(resolveProvider(initialModelId as string)).toBe(declaredProvider);
    },
  );
});
