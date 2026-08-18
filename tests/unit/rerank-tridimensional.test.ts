import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  computeDiversityScore,
  computeSalienceScore,
  combineScores,
  getTridimensionalWeights,
  applyTridimensionalRerank,
  type RerankResult,
} from '../../server/services/llm-reorder';

/**
 * Spec 10139: testa re-ranqueamento tridimensional (Relevância + Diversidade + Saliência).
 */

function makeResult(
  overrides: Partial<RerankResult> & { source: string; content: string },
): RerankResult {
  return {
    content: overrides.content,
    source: overrides.source,
    artigo_ou_secao: overrides.artigo_ou_secao ?? '',
    originalScore: overrides.originalScore ?? 0.5,
    rerankScore: overrides.rerankScore ?? 0.5,
    index: overrides.index ?? 0,
  };
}

describe('rerank tridimensional (spec 10139)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.RERANK_RELEVANCE_WEIGHT;
    delete process.env.RERANK_DIVERSITY_WEIGHT;
    delete process.env.RERANK_SALIENCE_WEIGHT;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('computeDiversityScore', () => {
    it('primeiro chunk sempre recebe 1.0', () => {
      const results = [makeResult({ source: 'A', content: 'x' })];
      expect(computeDiversityScore(results)).toEqual([1.0]);
    });

    it('chunks com mesma source recebem penalização', () => {
      const results = [
        makeResult({ source: 'A', content: 'x' }),
        makeResult({ source: 'A', content: 'y' }),
        makeResult({ source: 'B', content: 'z' }),
      ];
      const scores = computeDiversityScore(results);
      expect(scores[0]).toBe(1.0);
      expect(scores[1]).toBe(0.3); // mesma source A
      expect(scores[2]).toBe(1.0); // source nova B
    });

    it('chunks com sources todas diferentes recebem 1.0', () => {
      const results = [
        makeResult({ source: 'A', content: 'x' }),
        makeResult({ source: 'B', content: 'y' }),
        makeResult({ source: 'C', content: 'z' }),
      ];
      expect(computeDiversityScore(results)).toEqual([1.0, 1.0, 1.0]);
    });
  });

  describe('computeSalienceScore', () => {
    it('retorna 1.0 para conteúdo com marcador crítico', () => {
      const results = [
        makeResult({ source: 'A', content: 'Esta é uma decisão importante sobre o projeto.' }),
        makeResult({ source: 'B', content: 'Há um risco de segurança nesta área.' }),
      ];
      expect(computeSalienceScore(results)).toEqual([1.0, 1.0]);
    });

    it('retorna 0 para conteúdo sem marcador', () => {
      const results = [
        makeResult({ source: 'A', content: 'Texto descritivo sem marcadores críticos.' }),
      ];
      expect(computeSalienceScore(results)).toEqual([0.0]);
    });

    it('detecta marcadores com acentuação variada', () => {
      const results = [
        makeResult({ source: 'A', content: 'Decisao sem acento.' }),
        makeResult({ source: 'B', content: 'Divergencia detectada.' }),
        makeResult({ source: 'C', content: 'Bloqueio identificado.' }),
      ];
      expect(computeSalienceScore(results)).toEqual([1.0, 1.0, 1.0]);
    });
  });

  describe('combineScores', () => {
    it('combina scores com pesos fornecidos', () => {
      const relevance = [0.8, 0.6];
      const diversity = [1.0, 0.3];
      const salience = [1.0, 0.0];
      const weights = { relevance: 0.7, diversity: 0.2, salience: 0.1 };
      const final = combineScores(relevance, diversity, salience, weights);
      expect(final[0]).toBeCloseTo(0.7 * 0.8 + 0.2 * 1.0 + 0.1 * 1.0, 5);
      expect(final[1]).toBeCloseTo(0.7 * 0.6 + 0.2 * 0.3 + 0.1 * 0.0, 5);
    });

    it('backward compat: pesos 0 em diversidade e saliência reproduz relevância', () => {
      const relevance = [0.9, 0.5, 0.3];
      const diversity = [1.0, 0.3, 1.0];
      const salience = [1.0, 0.0, 1.0];
      const weights = { relevance: 1.0, diversity: 0, salience: 0 };
      const final = combineScores(relevance, diversity, salience, weights);
      expect(final).toEqual(relevance);
    });
  });

  describe('getTridimensionalWeights', () => {
    it('usa defaults 0.7/0.15/0.15 quando env não definido', () => {
      const w = getTridimensionalWeights();
      expect(w.relevance).toBeCloseTo(0.7, 5);
      expect(w.diversity).toBeCloseTo(0.15, 5);
      expect(w.salience).toBeCloseTo(0.15, 5);
      expect(w.relevance + w.diversity + w.salience).toBeCloseTo(1.0, 5);
    });

    it('lê pesos do env e normaliza se soma ≠ 1', () => {
      process.env.RERANK_RELEVANCE_WEIGHT = '0.6';
      process.env.RERANK_DIVERSITY_WEIGHT = '0.2';
      process.env.RERANK_SALIENCE_WEIGHT = '0.2';
      const w = getTridimensionalWeights();
      expect(w.relevance).toBeCloseTo(0.6, 5);
      expect(w.diversity).toBeCloseTo(0.2, 5);
      expect(w.salience).toBeCloseTo(0.2, 5);
    });

    it('normaliza pesos quando soma ≠ 1', () => {
      process.env.RERANK_RELEVANCE_WEIGHT = '2';
      process.env.RERANK_DIVERSITY_WEIGHT = '1';
      process.env.RERANK_SALIENCE_WEIGHT = '1';
      const w = getTridimensionalWeights();
      expect(w.relevance).toBeCloseTo(0.5, 5);
      expect(w.diversity).toBeCloseTo(0.25, 5);
      expect(w.salience).toBeCloseTo(0.25, 5);
    });
  });

  describe('applyTridimensionalRerank', () => {
    it('re-ordena por finalScore desc', () => {
      const results = [
        makeResult({ source: 'A', content: 'texto sem marcador', rerankScore: 0.9, index: 0 }),
        makeResult({
          source: 'B',
          content: 'decisão crítica sobre o sistema',
          rerankScore: 0.5,
          index: 1,
        }),
      ];
      const reordered = applyTridimensionalRerank(results);
      // Chunk B tem menor relevância (0.5) mas saliência 1.0 e diversidade 1.0.
      // Com pesos default 0.7/0.15/0.15:
      // A: 0.7*0.9 + 0.15*1.0 + 0.15*0.0 = 0.63 + 0.15 + 0 = 0.78
      // B: 0.7*0.5 + 0.15*1.0 + 0.15*1.0 = 0.35 + 0.15 + 0.15 = 0.65
      // A ainda vence porque relevância domina.
      expect(reordered[0].source).toBe('A');
      expect(reordered[1].source).toBe('B');
      expect(reordered[0].finalScore).toBeGreaterThan(reordered[1].finalScore!);
    });

    it('promove chunk diverso quando relevância é similar', () => {
      const results = [
        makeResult({ source: 'A', content: 'texto descritivo 1', rerankScore: 0.7, index: 0 }),
        makeResult({ source: 'A', content: 'texto descritivo 2', rerankScore: 0.7, index: 1 }),
        makeResult({ source: 'B', content: 'texto descritivo 3', rerankScore: 0.68, index: 2 }),
      ];
      const reordered = applyTridimensionalRerank(results);
      // Chunk C (source B) tem diversidade 1.0 vs 0.3 dos chunks A repetidos.
      // A: 0.7*0.7 + 0.15*1.0 + 0.15*0 = 0.49 + 0.15 = 0.64
      // B: 0.7*0.7 + 0.15*0.3 + 0.15*0 = 0.49 + 0.045 = 0.535
      // C: 0.7*0.68 + 0.15*1.0 + 0.15*0 = 0.476 + 0.15 = 0.626
      // C supera B pela diversidade.
      const sources = reordered.map((r) => r.source);
      expect(sources).toContain('B');
      const bIndex = sources.indexOf('B');
      const a2Index = sources.indexOf('A', 1); // segundo A
      expect(bIndex).toBeLessThan(a2Index === -1 ? sources.length : a2Index);
    });

    it('enriquece cada result com diversityScore, salienceScore e finalScore', () => {
      const results = [
        makeResult({ source: 'A', content: 'risco identificado', rerankScore: 0.8 }),
      ];
      const reordered = applyTridimensionalRerank(results);
      expect(reordered[0].diversityScore).toBe(1.0);
      expect(reordered[0].salienceScore).toBe(1.0);
      expect(reordered[0].finalScore).toBeCloseTo(0.7 * 0.8 + 0.15 * 1.0 + 0.15 * 1.0, 5);
    });

    it('backward compat: com pesos 0 em diversidade/saliência, ordem = relevância', () => {
      process.env.RERANK_RELEVANCE_WEIGHT = '1';
      process.env.RERANK_DIVERSITY_WEIGHT = '0';
      process.env.RERANK_SALIENCE_WEIGHT = '0';
      const results = [
        makeResult({ source: 'A', content: 'x', rerankScore: 0.5 }),
        makeResult({ source: 'B', content: 'decisão', rerankScore: 0.9 }),
        makeResult({ source: 'A', content: 'y', rerankScore: 0.7 }),
      ];
      const reordered = applyTridimensionalRerank(results);
      expect(reordered.map((r) => r.rerankScore)).toEqual([0.9, 0.7, 0.5]);
    });
  });
});
