/**
 * Testes unitários — few-shot-scoring (achado 4.4).
 * Cobre as funções puras: cosineSimilarity, deltaToScore, ranking e filtragem.
 */
import { describe, it, expect } from 'vitest';
import {
  cosineSimilarity,
  deltaToScore,
  effectiveScore,
  rankByEfficacy,
  filterByThreshold,
  selectForInjection,
  NEUTRAL_EFFICACY_SCORE,
} from '../../server/services/few-shot-scoring';
import type { StructuredFewShotExample } from '../../server/services/few-shot-bank';

function ex(id: string, score?: number): StructuredFewShotExample {
  return {
    id,
    agent: 'qa',
    demand: { title: 'T', description: 'D' },
    validOutput: 'saída válida',
    ...(score !== undefined ? { efficacy: { score, method: 'ablation' as const } } : {}),
  };
}

describe('cosineSimilarity', () => {
  it('1.0 para textos idênticos', () => {
    expect(
      cosineSimilarity('analise da demanda concreta', 'analise da demanda concreta'),
    ).toBeCloseTo(1, 5);
  });

  it('0 quando não há sobreposição de termos', () => {
    expect(cosineSimilarity('alpha bravo charlie', 'xxxx yyyy zzzz')).toBe(0);
  });

  it('0 para entrada vazia', () => {
    expect(cosineSimilarity('', 'qualquer coisa')).toBe(0);
  });

  it('valor intermediário para sobreposição parcial', () => {
    const sim = cosineSimilarity('analise da demanda', 'analise do problema');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
});

describe('deltaToScore', () => {
  it('delta 0 => 50 (neutro)', () => {
    expect(deltaToScore(0)).toBe(50);
  });
  it('delta +1 => 100, delta -1 => 0 (clamp)', () => {
    expect(deltaToScore(1)).toBe(100);
    expect(deltaToScore(-1)).toBe(0);
    expect(deltaToScore(5)).toBe(100);
    expect(deltaToScore(-5)).toBe(0);
  });
  it('delta positivo pequeno fica acima de 50', () => {
    expect(deltaToScore(0.2)).toBe(60);
  });
});

describe('effectiveScore', () => {
  it('usa o score quando presente', () => {
    expect(effectiveScore(ex('a', 80))).toBe(80);
  });
  it('usa neutro quando ausente', () => {
    expect(effectiveScore(ex('a'))).toBe(NEUTRAL_EFFICACY_SCORE);
  });
});

describe('rankByEfficacy', () => {
  it('ordena por score desc, não avaliados no meio (neutro)', () => {
    const ranked = rankByEfficacy([ex('low', 10), ex('unscored'), ex('high', 90)]);
    expect(ranked.map((e) => e.id)).toEqual(['high', 'unscored', 'low']);
  });

  it('estável para empates (mantém ordem original)', () => {
    const ranked = rankByEfficacy([ex('a', 70), ex('b', 70)]);
    expect(ranked.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('filterByThreshold', () => {
  it('threshold <= 0 não filtra nada', () => {
    const list = [ex('a', 10), ex('b')];
    expect(filterByThreshold(list, 0)).toHaveLength(2);
    expect(filterByThreshold(list, -5)).toHaveLength(2);
  });

  it('descarta reprovados, mas mantém não avaliados', () => {
    const list = [ex('reprovado', 30), ex('aprovado', 80), ex('novo')];
    const kept = filterByThreshold(list, 50).map((e) => e.id);
    expect(kept).toContain('aprovado');
    expect(kept).toContain('novo'); // sem score sempre passa
    expect(kept).not.toContain('reprovado');
  });
});

describe('selectForInjection', () => {
  it('filtra reprovados e rankeia os restantes', () => {
    const list = [ex('bom', 90), ex('ruim', 20), ex('medio', 60)];
    const selected = selectForInjection(list, 50).map((e) => e.id);
    expect(selected).toEqual(['bom', 'medio']);
  });
});
