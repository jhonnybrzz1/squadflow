import { describe, expect, it } from 'vitest';
import { aggregateDeterministicAgentValidations } from '../../server/cognitive-core/agent-validation-policy';

describe('deterministic agent cross-validation', () => {
  it('aggregates the lowest validator score without an LLM call', () => {
    const result = aggregateDeterministicAgentValidations(
      ['qa', 'tech_lead'],
      [
        { agentName: 'qa', isValid: true, score: 92, issues: [] },
        { agentName: 'tech_lead', isValid: true, score: 81, issues: [] },
      ],
    );

    expect(result.confidenceScore).toBe(81);
    expect(result.validationPassed).toBe(true);
  });

  it('fails when a deterministic validation is below threshold', () => {
    const result = aggregateDeterministicAgentValidations(
      ['qa'],
      [{ agentName: 'qa', isValid: false, score: 55, issues: ['missing evidence'] }],
    );

    expect(result.validationPassed).toBe(false);
    expect(result.validationNotes.join(' ')).toContain('missing evidence');
  });

  it('does not silently assume success when validation evidence is missing', () => {
    const result = aggregateDeterministicAgentValidations(['qa', 'tech_lead'], []);

    expect(result.confidenceScore).toBe(60);
    expect(result.validationPassed).toBe(false);
  });
});
