import { describe, it, expect } from 'vitest';
import {
  extractPatterns,
  type ExtractedPattern,
  type SelfImprovementInput,
} from '../../server/services/ai-squad/self-improvement-extractor';

function buildInput(overrides: Partial<SelfImprovementInput> = {}): SelfImprovementInput {
  return {
    demandId: 42,
    agentsFailed: [],
    totalDivergences: 0,
    rounds: [],
    consolidation: {
      problema: 'p',
      objetivo: 'o',
      escopo: 'e',
      criterios_de_aceite: [],
      riscos: [],
      dependencias: [],
      divergencias: [],
      consolidacao: 'c',
    },
    turnMetadata: [],
    ...overrides,
  };
}

function findPatternByType(
  patterns: ExtractedPattern[],
  type: string,
): ExtractedPattern | undefined {
  return patterns.find(
    (p) =>
      typeof p.extracted_pattern === 'object' &&
      p.extracted_pattern !== null &&
      (p.extracted_pattern as Record<string, unknown>).type === type,
  );
}

describe('self-improvement-extractor', () => {
  it('returns no_clear_pattern when there are no relevant signals', () => {
    const result = extractPatterns(buildInput());
    expect(result).toHaveLength(1);
    expect(result[0].extracted_pattern).toMatchObject({ type: 'no_clear_pattern' });
    expect(result[0].confidence_hint).toBe('low');
    expect(result[0].roundtable_id).toBe(42);
  });

  it('detects repeated parse failures by agent', () => {
    const result = extractPatterns(
      buildInput({
        turnMetadata: [
          {
            agentId: 'tech_lead',
            modelUsed: 'm1',
            durationMs: 1000,
            content: '',
            parseFailed: true,
            retried: true,
            round: 1,
          },
          {
            agentId: 'tech_lead',
            modelUsed: 'm1',
            durationMs: 1200,
            content: '',
            parseFailed: true,
            retried: false,
            round: 2,
          },
          {
            agentId: 'product_owner',
            modelUsed: 'm2',
            durationMs: 900,
            content: 'ok',
            parseFailed: false,
            retried: false,
            round: 1,
          },
        ],
      }),
    );

    const failurePattern = findPatternByType(result, 'repeated_parse_failure');
    expect(failurePattern).toBeDefined();
    expect(failurePattern!.agent_type).toBe('tech_lead');
    expect(failurePattern!.confidence_hint).toBe('high');
    expect(failurePattern!.extracted_pattern).toMatchObject({
      agentId: 'tech_lead',
      failedTurns: 2,
    });
  });

  it('detects slow turns above threshold', () => {
    const result = extractPatterns(
      buildInput({
        turnMetadata: [
          {
            agentId: 'tech_lead',
            modelUsed: 'm1',
            durationMs: 60_000,
            content: 'ok',
            parseFailed: false,
            retried: false,
            round: 1,
          },
        ],
      }),
    );

    const slowPattern = findPatternByType(result, 'slow_turn');
    expect(slowPattern).toBeDefined();
    expect(slowPattern!.agent_type).toBe('tech_lead');
    expect(slowPattern!.confidence_hint).toBe('medium');
  });

  it('detects high divergence rate', () => {
    const result = extractPatterns(
      buildInput({
        totalDivergences: 3,
        rounds: [{ round: 1, contributions: {}, divergences: ['a', 'b', 'c'] }],
      }),
    );

    const divergencePattern = findPatternByType(result, 'high_divergence_rate');
    expect(divergencePattern).toBeDefined();
    expect(divergencePattern!.agent_type).toBe('squad');
  });

  it('detects unmitigated high risks in consolidation', () => {
    const result = extractPatterns(
      buildInput({
        consolidation: {
          riscos: ['Risco ALTA criticidade', 'Risco baixa'],
        },
      }),
    );

    const riskPattern = findPatternByType(result, 'unmitigated_high_risk');
    expect(riskPattern).toBeDefined();
    expect(riskPattern!.agent_type).toBe('squad');
  });

  it('returns extraction_error for invalid input', () => {
    const result = extractPatterns({} as unknown as SelfImprovementInput);
    expect(result).toHaveLength(1);
    expect(result[0].extraction_error).toContain('Invalid input');
  });

  it('ignores single retry and reports retry_needed only from 2+ retries', () => {
    const resultOnce = extractPatterns(
      buildInput({
        turnMetadata: [
          {
            agentId: 'tech_lead',
            modelUsed: 'm1',
            durationMs: 1000,
            content: 'ok',
            parseFailed: false,
            retried: true,
            round: 1,
          },
        ],
      }),
    );
    expect(findPatternByType(resultOnce, 'retry_needed')).toBeUndefined();

    const resultTwice = extractPatterns(
      buildInput({
        turnMetadata: [
          {
            agentId: 'tech_lead',
            modelUsed: 'm1',
            durationMs: 1000,
            content: 'ok',
            parseFailed: false,
            retried: true,
            round: 1,
          },
          {
            agentId: 'tech_lead',
            modelUsed: 'm1',
            durationMs: 1100,
            content: 'ok',
            parseFailed: false,
            retried: true,
            round: 2,
          },
        ],
      }),
    );
    const retryPattern = findPatternByType(resultTwice, 'retry_needed');
    expect(retryPattern).toBeDefined();
    expect(retryPattern!.agent_type).toBe('tech_lead');
    expect(retryPattern!.extracted_pattern).toMatchObject({ retryCount: 2 });
  });
});
