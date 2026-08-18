import { describe, it, expect, beforeEach } from 'vitest';
import { numericProvenanceMetrics } from '../server/services/numeric-provenance-metrics';
import type { NumericClaimProvenance } from '../server/services/numeric-integrity-validator';

const ledger: NumericClaimProvenance[] = [
  { value: '40%', location: 'prose', anchored: true, anchoredBy: '40% das falhas', action: 'kept' },
  { value: '4:1', location: 'prose', anchored: false, action: 'removed' },
  {
    value: '5%',
    location: 'metrics_table',
    field: 'meta',
    anchored: false,
    action: 'marked',
  },
];

describe('numericProvenanceMetrics (Fase 3 / slice 4)', () => {
  beforeEach(() => {
    numericProvenanceMetrics.reset();
  });

  it('agrega contagens de claims ancorados/não-ancorados a partir do ledger', () => {
    numericProvenanceMetrics.record({ demandId: 1, sourceLabel: 'PRD', ledger });

    const summary = numericProvenanceMetrics.getSummary();
    expect(summary.claimsTotal).toBe(3);
    expect(summary.claimsAnchored).toBe(1);
    expect(summary.claimsUnanchored).toBe(2);
    expect(summary.demandsWithUnanchored).toBe(1);
    expect(summary.recentRecords[0].unanchoredClaims).toEqual(['4:1', '5%']);
  });

  it('ignora ledger vazio (não cria registro)', () => {
    numericProvenanceMetrics.record({ demandId: 2, ledger: [] });
    expect(numericProvenanceMetrics.getSummary().recentRecords).toHaveLength(0);
  });

  it('soma múltiplas demandas e conta demandas distintas com claims sem origem', () => {
    numericProvenanceMetrics.record({ demandId: 1, ledger });
    numericProvenanceMetrics.record({ demandId: 2, ledger });

    const summary = numericProvenanceMetrics.getSummary();
    expect(summary.claimsTotal).toBe(6);
    expect(summary.claimsUnanchored).toBe(4);
    expect(summary.demandsWithUnanchored).toBe(2);
  });
});
