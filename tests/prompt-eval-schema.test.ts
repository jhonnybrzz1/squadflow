import { describe, expect, it } from 'vitest';
import {
  calculateCompositeQualityScore,
  calculateErrorHandling,
  calculateSourceGrounding,
  calculateTokenMatch,
  safeValidateEvalDataset,
} from '../shared/prompt-eval-schema';

describe('prompt evaluation metrics', () => {
  it('matches structural tokens ignoring accents and case', () => {
    const result = calculateTokenMatch('Relatorio MENSAL do PERIODO com fonte oficial.', [
      'relatório',
      'MENSAL',
      'período',
    ]);

    expect(result.present).toEqual(['relatório', 'MENSAL', 'período']);
    expect(result.percentage).toBe(100);
  });

  it('requires at least one valid source for grounded answers', () => {
    const grounded = calculateSourceGrounding('Fonte: Banco Central do Brasil.', [
      'BCB',
      'Banco Central',
    ]);
    const ungrounded = calculateSourceGrounding('Fonte: blog interno.', ['BCB', 'Banco Central']);

    expect(grounded.groundedness).toBe(1);
    expect(grounded.percentage).toBe(100);
    expect(grounded.present).toEqual(['Banco Central']);
    expect(ungrounded.groundedness).toBe(0);
  });

  it('treats error cases as valid only when the response refuses or asks for clarification', () => {
    expect(calculateErrorHandling('Nao foi possivel consultar esta data invalida.', 'erro')).toBe(
      1,
    );
    expect(calculateErrorHandling('A cotacao e R$ 5,00.', 'erro')).toBe(0);
    expect(calculateErrorHandling('A cotacao e R$ 5,00.', 'geral')).toBe(1);
  });

  it('calculates a weighted composite quality score', () => {
    expect(
      calculateCompositeQualityScore({
        similarity: 0.9,
        tokensPct: 80,
        groundedness: 1,
        errorHandling: 1,
      }),
    ).toBe(91);
  });

  it('rejects substantive dataset pairs without valid sources', () => {
    const result = safeValidateEvalDataset({
      description: 'dataset invalido',
      version: '1.0.0',
      target_similarity_pct: 85,
      target_structure_pct: 90,
      created_at: '2026-06-03',
      categories: ['geral'],
      pairs: [
        {
          id: 'eval-001',
          categoria: 'geral',
          dificuldade: 'simples',
          pergunta: 'Qual e a política de retenção de dados?',
          resposta_esperada: 'A resposta deve citar uma fonte oficial e explicar a política.',
          tokens_estruturais: ['retenção'],
          fontes_validas: [],
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});
