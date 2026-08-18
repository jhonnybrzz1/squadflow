import { describe, expect, it } from 'vitest';
import { PromptParser } from '../server/services/ai-squad/prompt-parser';
import { typeContractValidator } from '../server/utils/typeContractValidator';

describe('PromptParser.ensurePrdMatchesRefinementType', () => {
  it('adds missing technical sections when TDD is structurally incomplete', () => {
    const incompleteTdd = `# TDD - POC OCR Invoice

## 1. Visão Geral
Objetivo técnico da POC.

## Evidências do Refinamento
- endpoint OCR retorna confidence por campo
`;

    const result = PromptParser.ensurePrdMatchesRefinementType(
      incompleteTdd,
      'technical',
      '- endpoint OCR retorna confidence por campo',
    );

    const adherence = typeContractValidator.validateTypeAdherence(result, 'technical');

    expect(result).toContain('## 2. Arquitetura Proposta');
    expect(result).toContain('## 4. Definição de APIs (Contratos)');
    expect(result).toContain('## 6. Considerações de Performance e Segurança');
    expect(adherence.isAdherent).toBe(true);
  });

  it('does not change business PRDs', () => {
    const prd = '# PRD\n\n## Objetivo\nValidar hipótese.';
    expect(PromptParser.ensurePrdMatchesRefinementType(prd, 'business', '- digest')).toBe(prd);
  });
});
