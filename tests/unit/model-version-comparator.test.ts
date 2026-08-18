import { describe, it, expect } from 'vitest';
import { buildSignature, compareModels } from '../../server/services/model-version-comparator';
import { findFamilyByAlias } from '../../server/services/model-family-rules';

describe('model-version-comparator', () => {
  describe('semantic-version strategy', () => {
    const family = findFamilyByAlias('mimo-pro-latest')!;

    it('extracts version 2.5 from mimo-v2.5-pro', () => {
      const sig = buildSignature('semantic-version', 'mimo-v2.5-pro', family);
      expect(sig).not.toBeNull();
      expect(sig?.token).toBe('2.5');
    });

    it('compares 3.0 as newer than 2.5', () => {
      const result = compareModels({
        family,
        currentModelId: 'mimo-v2.5-pro',
        candidateModelId: 'mimo-v3.0-pro',
      });
      expect(result.winner).toBe('candidate');
      expect(result.reason).toBe('higher-primary');
    });

    it('compares 2.5 as not newer than 3.0', () => {
      const result = compareModels({
        family,
        currentModelId: 'mimo-v3.0-pro',
        candidateModelId: 'mimo-v2.5-pro',
      });
      expect(result.winner).toBe('current');
    });

    it('returns tie for equal versions', () => {
      const result = compareModels({
        family,
        currentModelId: 'mimo-v2.5-pro',
        candidateModelId: 'mimo-v2.5-pro',
      });
      expect(result.winner).toBe('tie');
    });

    it('does not allow glm-flash to replace glm-latest (different families)', () => {
      // This is enforced at the family-rules level (excludePatterns), not the
      // comparator. The comparator only runs within a single family.
      const glmFamily = findFamilyByAlias('glm-latest')!;
      const result = compareModels({
        family: glmFamily,
        currentModelId: 'z-ai/glm-5.2',
        candidateModelId: 'z-ai/glm-5.2-flash',
      });
      // glm-5.2-flash does NOT match the glm family include pattern, so it
      // would be filtered out before comparison. But if forced, the comparator
      // extracts 5.2 from both and returns tie.
      expect(['tie', 'incomparable']).toContain(result.winner);
    });
  });

  describe('numeric-generation strategy', () => {
    const family = findFamilyByAlias('deepseek-v4-pro-latest')!;

    it('extracts generation 4 from deepseek-v4-pro', () => {
      const sig = buildSignature('numeric-generation', 'deepseek/deepseek-v4-pro', family);
      expect(sig).not.toBeNull();
      expect(sig?.value).toBe(4);
    });

    it('compares v5 as newer than v4', () => {
      const result = compareModels({
        family,
        currentModelId: 'deepseek/deepseek-v4-pro',
        candidateModelId: 'deepseek/deepseek-v5-pro',
      });
      expect(result.winner).toBe('candidate');
    });

    it('does not compare pro with flash (different families)', () => {
      const flashFamily = findFamilyByAlias('deepseek-v4-flash-latest')!;
      const result = compareModels({
        family: flashFamily,
        currentModelId: 'deepseek/deepseek-v4-flash',
        candidateModelId: 'deepseek/deepseek-v4-pro',
      });
      // pro does not match the flash family's include pattern, so it would be
      // filtered before comparison. The comparator extracts generation 4 from
      // both, returning tie.
      expect(['tie', 'incomparable']).toContain(result.winner);
    });
  });

  describe('minimax numeric-generation', () => {
    const family = findFamilyByAlias('minimax-m-latest')!;

    it('extracts generation from minimax-m3', () => {
      const sig = buildSignature('numeric-generation', 'minimax/minimax-m3', family);
      expect(sig?.value).toBe(3);
    });

    it('compares m4 as newer than m3', () => {
      const result = compareModels({
        family,
        currentModelId: 'minimax/minimax-m3',
        candidateModelId: 'minimax/minimax-m4',
      });
      expect(result.winner).toBe('candidate');
    });
  });

  describe('native-latest-alias strategy', () => {
    const family = findFamilyByAlias('codestral-latest')!;

    it('ranks native -latest alias as canonical', () => {
      const sig = buildSignature('native-latest-alias', 'codestral-latest', family);
      expect(sig?.value).toBe(1);
    });

    it('ranks versioned id below the native alias', () => {
      const sig = buildSignature('native-latest-alias', 'codestral-25.08', family);
      expect(sig?.value).toBe(0);
    });

    it('does not replace native alias with versioned id', () => {
      const result = compareModels({
        family,
        currentModelId: 'codestral-latest',
        candidateModelId: 'codestral-25.08',
      });
      expect(result.winner).toBe('current');
    });
  });

  describe('explicit-priority strategy (qwen-coder)', () => {
    const family = findFamilyByAlias('qwen-coder-latest')!;

    it('ranks -next suffix as highest priority', () => {
      const sig = buildSignature('explicit-priority', 'qwen/qwen3-coder-next', family);
      expect(sig?.value).toBe(0); // first preferred suffix index
    });

    it('ranks non-next suffix as lower priority', () => {
      const sig = buildSignature('explicit-priority', 'qwen/qwen3-coder', family);
      expect(sig?.value).toBe(-1); // no preferred suffix match
    });

    it('ranks -preview as deprioritized', () => {
      const sig = buildSignature('explicit-priority', 'qwen/qwen3-coder-preview', family);
      expect(sig?.value).toBe(-2); // excluded suffix
    });

    it('prefers -next over base qwen3-coder', () => {
      const result = compareModels({
        family,
        currentModelId: 'qwen/qwen3-coder',
        candidateModelId: 'qwen/qwen3-coder-next',
      });
      expect(result.winner).toBe('candidate');
    });

    it('does not replace -next with base', () => {
      const result = compareModels({
        family,
        currentModelId: 'qwen/qwen3-coder-next',
        candidateModelId: 'qwen/qwen3-coder',
      });
      expect(result.winner).toBe('current');
    });
  });

  describe('no-auto-comparison strategy', () => {
    it('returns null signature', () => {
      const family = {
        alias: 'test',
        family: 'test',
        provider: 'test',
        initialModelId: 'test',
        includePatterns: [],
        excludePatterns: [],
        minimumContextLength: 0,
        requiredInputModalities: [],
        comparisonStrategy: 'no-auto-comparison' as const,
        autoPromote: false,
      };
      const sig = buildSignature('no-auto-comparison', 'test-model', family);
      expect(sig).toBeNull();
    });
  });

  describe('incomparable cases', () => {
    it('returns incomparable when no version can be extracted', () => {
      const family = findFamilyByAlias('mimo-pro-latest')!;
      const result = compareModels({
        family,
        currentModelId: 'no-version-here',
        candidateModelId: 'also-no-version',
      });
      expect(result.winner).toBe('incomparable');
    });
  });
});
