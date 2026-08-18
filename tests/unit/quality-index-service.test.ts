import { describe, it, expect } from 'vitest';
import { QualityIndexService } from '../../server/services/quality-index-service';

describe('QualityIndexService', () => {
  it('computeOverall calcula média dos scores disponíveis', () => {
    const overall = QualityIndexService.computeOverall({
      groundednessScore: 0.9,
      numericIntegrityScore: 0.8,
      citedPathScore: null,
      overallScore: null,
    });
    expect(overall).toBeCloseTo(0.85, 2);
  });

  it('computeOverall retorna null quando nenhum score está disponível', () => {
    const overall = QualityIndexService.computeOverall({
      groundednessScore: null,
      numericIntegrityScore: null,
      citedPathScore: null,
      overallScore: null,
    });
    expect(overall).toBeNull();
  });
});
