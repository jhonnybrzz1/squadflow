import type { NumericClaimProvenance } from './numeric-integrity-validator';
import { numericProvenanceViolationsTotal } from '../metrics';

/**
 * Telemetria in-memory da provenance numérica (Fase 3 / slice 4). Consome o `ledger`
 * do NumericIntegrityValidator para observabilidade: quantos claims numéricos foram
 * detectados, quantos estavam ancorados em fontes reais e quais não tinham origem.
 * Mesmo padrão de documentEvidenceMetrics (in-memory, limitado, com getSummary).
 */
interface NumericProvenanceRecord {
  demandId: number;
  timestamp: string;
  sourceLabel: string;
  claimsTotal: number;
  claimsAnchored: number;
  claimsUnanchored: number;
  unanchoredClaims: string[];
}

class NumericProvenanceMetrics {
  private records: NumericProvenanceRecord[] = [];
  private readonly maxRecords = 500;

  record(input: {
    demandId: number;
    sourceLabel?: string;
    ledger: NumericClaimProvenance[];
  }): void {
    const { ledger } = input;
    if (ledger.length === 0) return;

    const unanchoredClaims = ledger.filter((claim) => !claim.anchored).map((claim) => claim.value);
    if (unanchoredClaims.length > 0) {
      numericProvenanceViolationsTotal
        .labels(input.sourceLabel ?? 'PRD')
        .inc(unanchoredClaims.length);
    }

    this.records.push({
      demandId: input.demandId,
      timestamp: new Date().toISOString(),
      sourceLabel: input.sourceLabel ?? 'PRD',
      claimsTotal: ledger.length,
      claimsAnchored: ledger.filter((claim) => claim.anchored).length,
      claimsUnanchored: unanchoredClaims.length,
      unanchoredClaims,
    });

    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
  }

  getSummary(): {
    claimsTotal: number;
    claimsAnchored: number;
    claimsUnanchored: number;
    demandsWithUnanchored: number;
    recentRecords: NumericProvenanceRecord[];
  } {
    const totals = this.records.reduce(
      (acc, record) => {
        acc.claimsTotal += record.claimsTotal;
        acc.claimsAnchored += record.claimsAnchored;
        acc.claimsUnanchored += record.claimsUnanchored;
        return acc;
      },
      { claimsTotal: 0, claimsAnchored: 0, claimsUnanchored: 0 },
    );

    const demandsWithUnanchored = new Set(
      this.records.filter((record) => record.claimsUnanchored > 0).map((record) => record.demandId),
    ).size;

    return {
      ...totals,
      demandsWithUnanchored,
      recentRecords: this.records.slice(-10).reverse(),
    };
  }

  reset(): void {
    this.records = [];
  }
}

export const numericProvenanceMetrics = new NumericProvenanceMetrics();
