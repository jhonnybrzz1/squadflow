import { describe, expect, it } from 'vitest';
import { calculateRetrievalMetrics } from '../../server/evaluation/retrieval-metrics';

describe('RAG retrieval metrics', () => {
  it('calculates recall@k, precision@k and reciprocal rank', () => {
    expect(calculateRetrievalMetrics(['a', 'b', 'c', 'd'], ['b', 'd'], 3)).toEqual({
      recallAtK: 0.5,
      precisionAtK: 1 / 3,
      reciprocalRank: 0.5,
    });
  });

  it('returns zero when no relevant chunk is retrieved', () => {
    expect(calculateRetrievalMetrics(['a', 'b'], ['x'], 5)).toEqual({
      recallAtK: 0,
      precisionAtK: 0,
      reciprocalRank: 0,
    });
  });

  it('rejects invalid k', () => {
    expect(() => calculateRetrievalMetrics([], [], 0)).toThrow('positive integer');
  });
});
