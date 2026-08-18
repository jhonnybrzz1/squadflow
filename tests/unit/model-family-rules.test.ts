import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadModelFamiliesConfig,
  clearModelFamiliesCache,
  findFamilyByAlias,
  findFamilyByModelId,
  isEligibleCandidate,
  modelFamilySchema,
} from '../../server/services/model-family-rules';

describe('model-family-rules', () => {
  beforeEach(() => {
    clearModelFamiliesCache();
  });

  describe('loadModelFamiliesConfig', () => {
    it('loads and validates the config file', () => {
      const config = loadModelFamiliesConfig();
      expect(config.version).toBe(1);
      expect(config.families.length).toBeGreaterThanOrEqual(11);
    });

    it('caches the config on repeated calls', () => {
      const first = loadModelFamiliesConfig();
      const second = loadModelFamiliesConfig();
      expect(second).toBe(first);
    });

    it('returns empty config when file does not exist', () => {
      clearModelFamiliesCache();
      const config = loadModelFamiliesConfig('/nonexistent/path.json');
      expect(config.families).toEqual([]);
    });
  });

  describe('findFamilyByAlias', () => {
    it('finds a family by its alias', () => {
      const family = findFamilyByAlias('mimo-pro-latest');
      expect(family).toBeDefined();
      expect(family?.provider).toBe('xiaomi');
      expect(family?.initialModelId).toBe('mimo-v2.5-pro');
    });

    it('returns undefined for unknown alias', () => {
      expect(findFamilyByAlias('nonexistent-alias')).toBeUndefined();
    });
  });

  describe('findFamilyByModelId', () => {
    it('finds a family by its initial model id', () => {
      const family = findFamilyByModelId('mimo-v2.5-pro');
      expect(family?.alias).toBe('mimo-pro-latest');
    });

    it('finds a family by its fallback model id when no family owns it as primary', () => {
      const family = findFamilyByModelId('deepseek/deepseek-v4-pro');
      expect(family).toBeDefined();
    });

    it('is case-insensitive', () => {
      const family = findFamilyByModelId('MIMO-V2.5-PRO');
      expect(family?.alias).toBe('mimo-pro-latest');
    });

    it('returns undefined for unknown model id', () => {
      expect(findFamilyByModelId('unknown/model')).toBeUndefined();
    });

    describe('disambiguates ids shared between a family and others fallbacks (CRIT reaudit)', () => {
      // Several families reuse the *same* concrete id as their fallback
      // (e.g. `mistral-medium-3.5` is the fallback of mimo-general-latest,
      // minimax-m-latest AND deepseek-v4-pro-latest), while exactly one
      // family owns that id as its own `initialModelId`. The owner must
      // always win — picking an arbitrary unrelated family (by array order)
      // could collapse a primary/fallback pair into the same model or swap
      // an agent into an unrelated family when resolved through the
      // registry bridge.
      it('resolves deepseek/deepseek-v4-pro to its owner (deepseek-v4-pro-latest), not a family that merely lists it as fallback', () => {
        const family = findFamilyByModelId('deepseek/deepseek-v4-pro');
        expect(family?.alias).toBe('deepseek-v4-pro-latest');
      });

      it('resolves mistral-medium-3.5 to its owner (mistral-medium-latest)', () => {
        const family = findFamilyByModelId('mistral-medium-3.5');
        expect(family?.alias).toBe('mistral-medium-latest');
      });

      it('resolves mistral-small-2603 to its owner (mistral-small-latest)', () => {
        const family = findFamilyByModelId('mistral-small-2603');
        expect(family?.alias).toBe('mistral-small-latest');
      });

      it('resolves deepseek/deepseek-v4-flash to its owner (deepseek-v4-flash-latest)', () => {
        const family = findFamilyByModelId('deepseek/deepseek-v4-flash');
        expect(family?.alias).toBe('deepseek-v4-flash-latest');
      });

      it('still falls back to a fallback-only match when no family owns the id as primary', () => {
        // codestral-latest is the initialModelId of its own family AND the
        // fallback of qwen-coder-latest — owner match must still win.
        const family = findFamilyByModelId('codestral-latest');
        expect(family?.alias).toBe('codestral-latest');
      });
    });
  });

  describe('isEligibleCandidate', () => {
    const mimoProFamily = () => findFamilyByAlias('mimo-pro-latest')!;

    it('accepts a matching pro model', () => {
      const result = isEligibleCandidate(mimoProFamily(), 'mimo-v3.0-pro', {
        contextLength: 200000,
        inputModalities: ['text'],
      });
      expect(result.eligible).toBe(true);
    });

    it('rejects ultraspeed variant', () => {
      const result = isEligibleCandidate(mimoProFamily(), 'mimo-v2.5-pro-ultraspeed');
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('exclude-pattern');
    });

    it('rejects preview variants by default', () => {
      const result = isEligibleCandidate(mimoProFamily(), 'mimo-v3.0-pro-preview');
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('default-exclude:preview');
    });

    it('rejects beta variants by default', () => {
      const result = isEligibleCandidate(mimoProFamily(), 'mimo-v3.0-pro-beta');
      expect(result.eligible).toBe(false);
    });

    it('rejects experimental variants by default', () => {
      const result = isEligibleCandidate(mimoProFamily(), 'mimo-v3.0-pro-experimental');
      expect(result.eligible).toBe(false);
    });

    it('rejects free variants by default', () => {
      const result = isEligibleCandidate(mimoProFamily(), 'mimo-v3.0-pro:free');
      expect(result.eligible).toBe(false);
    });

    it('rejects when context length is below minimum', () => {
      const result = isEligibleCandidate(mimoProFamily(), 'mimo-v3.0-pro', {
        contextLength: 1000,
        inputModalities: ['text'],
      });
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('context-below-minimum');
    });

    it('rejects when required modality is missing', () => {
      const result = isEligibleCandidate(mimoProFamily(), 'mimo-v3.0-pro', {
        contextLength: 200000,
        inputModalities: ['image'],
      });
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('missing-modality');
    });

    it('rejects when no include pattern matches', () => {
      const result = isEligibleCandidate(mimoProFamily(), 'some-random-model');
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('no-include-pattern-match');
    });

    it('accepts when context/modality are not provided (deferred validation)', () => {
      const result = isEligibleCandidate(mimoProFamily(), 'mimo-v3.0-pro');
      expect(result.eligible).toBe(true);
    });
  });

  describe('qwen-coder explicit-priority family', () => {
    it('resolves to qwen3-coder-next as initial model', () => {
      const family = findFamilyByAlias('qwen-coder-latest');
      expect(family?.initialModelId).toBe('qwen/qwen3-coder-next');
    });

    it('has preferredSuffixes with -next', () => {
      const family = findFamilyByAlias('qwen-coder-latest');
      expect(family?.preferredSuffixes).toContain('-next');
    });

    it('has excludedSuffixes with -preview and -free', () => {
      const family = findFamilyByAlias('qwen-coder-latest');
      expect(family?.excludedSuffixes).toContain('-preview');
      expect(family?.excludedSuffixes).toContain('-free');
    });
  });

  describe('schema validation', () => {
    it('rejects a family with no alias', () => {
      const result = modelFamilySchema.safeParse({
        alias: '',
        family: 'test',
        provider: 'test',
        initialModelId: 'test',
        comparisonStrategy: 'semantic-version',
      });
      expect(result.success).toBe(false);
    });

    it('rejects an invalid comparison strategy', () => {
      const result = modelFamilySchema.safeParse({
        alias: 'test',
        family: 'test',
        provider: 'test',
        initialModelId: 'test',
        comparisonStrategy: 'invalid-strategy',
      });
      expect(result.success).toBe(false);
    });

    it('defaults autoPromote to false', () => {
      const result = modelFamilySchema.safeParse({
        alias: 'test',
        family: 'test',
        provider: 'test',
        initialModelId: 'test',
        comparisonStrategy: 'semantic-version',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.autoPromote).toBe(false);
      }
    });
  });
});
