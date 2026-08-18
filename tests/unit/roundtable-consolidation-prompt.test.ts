import { describe, expect, it } from 'vitest';
import {
  buildConsolidationSystemPrompt,
  buildConsolidationUserPrompt,
} from '../../server/orchestration-contracts/roundtable';

describe('roundtable consolidation prompts', () => {
  it('includes typeRequirements in system prompt when provided', () => {
    const prompt = buildConsolidationSystemPrompt(['Threat Model', 'Root Cause Analysis']);
    expect(prompt).toContain('Threat Model');
    expect(prompt).toContain('Root Cause Analysis');
    expect(prompt).toContain('OBRIGATORIAS');
  });

  it('does not include typeRequirements block when empty', () => {
    const prompt = buildConsolidationSystemPrompt([]);
    expect(prompt).not.toContain('OBRIGATORIAS');
  });

  it('includes typeRequirements in user prompt when provided', () => {
    const prompt = buildConsolidationUserPrompt(
      'Titulo',
      'Descricao',
      ['msg1'],
      ['div1'],
      ['Threat Model', 'Root Cause Analysis'],
    );
    expect(prompt).toContain('SECOES OBRIGATORIAS');
    expect(prompt).toContain('Threat Model');
    expect(prompt).toContain('Root Cause Analysis');
  });

  it('does not include typeRequirements block in user prompt when omitted', () => {
    const prompt = buildConsolidationUserPrompt('Titulo', 'Descricao', ['msg1'], ['div1']);
    expect(prompt).not.toContain('SECOES OBRIGATORIAS');
  });
});
