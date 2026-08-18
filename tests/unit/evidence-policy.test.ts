import { beforeEach, describe, expect, it, vi } from 'vitest';
import { featureFlags } from '../../server/services/feature-flags';
import { logger } from '../../server/utils/logger';
import {
  CONSERVATIVE_FALLBACK_RULE,
  PathValidationCache,
  emitBaselineRequirementSkipped,
  emitContractFalsePositiveObservation,
  emitHallucinatedPathBlocked,
  getEvidenceExtensions,
  resolveDemandTypeRule,
} from '../../server/services/evidence-policy';

const configuredRules = {
  discovery: {
    requireBaseline: false,
    evidenceMode: 'conceptual' as const,
    allowHallucinatedPaths: false as const,
  },
  bug: {
    requireBaseline: false,
    evidenceMode: 'verified' as const,
    allowHallucinatedPaths: false as const,
  },
  exploratoryAnalysis: {
    requireBaseline: true,
    evidenceMode: 'verified' as const,
    allowHallucinatedPaths: false as const,
  },
  newFeature: {
    requireBaseline: false,
    evidenceMode: 'conceptual' as const,
    allowHallucinatedPaths: false as const,
  },
  improvement: {
    requireBaseline: false,
    evidenceMode: 'verified' as const,
    allowHallucinatedPaths: false as const,
  },
  security: {
    requireBaseline: true,
    evidenceMode: 'verified' as const,
    allowHallucinatedPaths: false as const,
  },
  refactoring: {
    requireBaseline: true,
    evidenceMode: 'verified' as const,
    allowHallucinatedPaths: false as const,
  },
  infrastructure: {
    requireBaseline: true,
    evidenceMode: 'verified' as const,
    allowHallucinatedPaths: false as const,
  },
};

describe('evidence policy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const current = featureFlags.getFlags();
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
      ...current,
      demandTypeRules: configuredRules,
      evidenceExtensions: ['.ts', '.tsx', '.json', '.js', '.jsx', '.css', '.md'],
    });
  });

  it.each([
    ['discovery', 'discovery', false],
    ['bug', 'bug', false],
    ['bugfix', 'bug', false],
    ['analise_exploratoria', 'exploratoryAnalysis', true],
    ['analysis', 'exploratoryAnalysis', true],
    ['nova_funcionalidade', 'newFeature', false],
    ['new_feature', 'newFeature', false],
    ['melhoria', 'improvement', false],
    ['improvement', 'improvement', false],
    ['security', 'security', true],
    ['refactoring', 'refactoring', true],
    ['infraestrutura', 'infrastructure', true],
    ['infrastructure', 'infrastructure', true],
  ])('resolves %s through %s with baseline=%s', (input, ruleKey, requireBaseline) => {
    const resolved = resolveDemandTypeRule(input);
    expect(resolved.ruleKey).toBe(ruleKey);
    expect(resolved.rule.requireBaseline).toBe(requireBaseline);
    expect(resolved.rule.allowHallucinatedPaths).toBe(false);
    expect(resolved.source).toBe('config');
  });

  it('falls back conservatively for unknown or missing configuration', () => {
    expect(resolveDemandTypeRule('outro')).toEqual({
      ruleKey: 'unknown',
      rule: CONSERVATIVE_FALLBACK_RULE,
      source: 'fallback',
    });

    vi.mocked(featureFlags.getFlags).mockReturnValue({
      ...featureFlags.getFlags(),
      demandTypeRules: {},
    });
    expect(resolveDemandTypeRule('melhoria').rule).toEqual(CONSERVATIVE_FALLBACK_RULE);
  });

  it('returns the configured extension whitelist', () => {
    expect(getEvidenceExtensions()).toEqual(['.ts', '.tsx', '.json', '.js', '.jsx', '.css', '.md']);
  });

  it('expires entries and evicts the least recently used entry', () => {
    let now = 0;
    const cache = new PathValidationCache(2, 30, () => now);
    cache.set('repo', 'main', './a.ts', true);
    cache.set('repo', 'main', 'b.ts', false);
    expect(cache.get('repo', 'main', 'a.ts')).toBe(true);
    cache.set('repo', 'main', 'c.ts', true);
    expect(cache.get('repo', 'main', 'b.ts')).toBeUndefined();
    expect(cache.get('repo', 'main', 'c.ts')).toBe(true);
    now = 31;
    expect(cache.get('repo', 'main', 'a.ts')).toBeUndefined();
  });

  it('emits the three auditable events without prompt, response, token, or secret fields', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    emitHallucinatedPathBlocked({ path: 'src/missing.ts', demandType: 'bug', repoId: 'o/r' });
    emitBaselineRequirementSkipped({ demandType: 'melhoria' });
    emitContractFalsePositiveObservation({
      valid: null,
      demandType: 'bug',
      repoId: 'o/r',
      path: 'src/a.ts',
    });

    const contexts = info.mock.calls.map((call) => JSON.stringify(call[1]));
    expect(contexts.join('\n')).toContain('hallucinated_path_blocked');
    expect(contexts.join('\n')).toContain('baseline_requirement_skipped');
    expect(contexts.join('\n')).toContain('contract_false_positive_rate');
    expect(contexts.join('\n')).not.toMatch(/prompt|response|token|secret/i);
  });
});
