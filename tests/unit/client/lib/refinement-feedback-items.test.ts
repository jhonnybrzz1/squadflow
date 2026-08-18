import { describe, expect, it } from 'vitest';
import {
  extractRefinementFeedbackItems,
  stableFeedbackHash,
} from '../../../../client/src/lib/refinement-feedback-items';

describe('refinement feedback items', () => {
  it('extracts ordered and unordered recommendations with stable keys', () => {
    const result = extractRefinementFeedbackItems(`
1. Corrigir autenticação
- Adicionar cache
`);

    expect(result.map((item) => item.text)).toEqual(['Corrigir autenticação', 'Adicionar cache']);
    expect(result[0]?.itemIndex).toBe(0);
    expect(result[0]?.itemKey).toBe(stableFeedbackHash('corrigir autenticação'));
  });

  it('extracts the first cell from table rows and skips the header', () => {
    const result = extractRefinementFeedbackItems(`
| Recomendação | Detalhe |
| --- | --- |
| Corrigir autenticação | Segurança |
| Adicionar cache | Performance |
`);

    expect(result.map((item) => item.text)).toEqual(['Corrigir autenticação', 'Adicionar cache']);
  });

  it('keeps the item key stable when its position changes', () => {
    const first = extractRefinementFeedbackItems('1. Primeiro\n2. Recomendação estável');
    const second = extractRefinementFeedbackItems(
      '1. Novo item\n2. Primeiro\n3. Recomendação estável',
    );

    expect(first[1]?.itemKey).toBe(second[2]?.itemKey);
    expect(first[1]?.itemIndex).not.toBe(second[2]?.itemIndex);
  });

  it('deduplicates repeated recommendations', () => {
    const result = extractRefinementFeedbackItems('- Mesmo item\n- Mesmo item');
    expect(result).toHaveLength(1);
  });
});
