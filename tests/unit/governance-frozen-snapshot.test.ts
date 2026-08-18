import { describe, expect, it } from 'vitest';
import {
  isFrozenDocumentState,
  resolveFrozenSnapshotId,
} from '../../server/routes/governance-routes';

/**
 * Auditoria 2026-08-01 (A01): em UNDER_REVIEW/APPROVED/FINAL o DocumentViewer
 * buscava `/documents/:type` — o documento VIVO — enquanto o ReviewBanner
 * prometia imutabilidade. A rota `/review-snapshot` existia mas devolvia
 * sempre o snapshot de revisão e respondia 400 em FINAL, então nem havia de
 * onde ler o conteúdo congelado.
 */
describe('resolução do snapshot congelado por estado (A01)', () => {
  const full = {
    reviewSnapshotId: 'snap-review',
    approvedSnapshotId: 'snap-approved',
    finalSnapshotId: 'snap-final',
  };

  it('DRAFT não é um estado congelado', () => {
    expect(isFrozenDocumentState('DRAFT')).toBe(false);
  });

  it.each(['UNDER_REVIEW', 'APPROVED', 'FINAL'])('%s é um estado congelado', (state) => {
    expect(isFrozenDocumentState(state)).toBe(true);
  });

  it('cada estado resolve o seu próprio snapshot', () => {
    expect(resolveFrozenSnapshotId('UNDER_REVIEW', full)).toBe('snap-review');
    expect(resolveFrozenSnapshotId('APPROVED', full)).toBe('snap-approved');
    expect(resolveFrozenSnapshotId('FINAL', full)).toBe('snap-final');
  });

  it('APPROVED cai no snapshot de revisão quando o aprovado não foi gravado', () => {
    // Demandas anteriores à correção do A02 chegaram a APPROVED sem
    // `approvedSnapshotId` — o conteúdo revisado ainda é a melhor verdade.
    expect(
      resolveFrozenSnapshotId('APPROVED', {
        reviewSnapshotId: 'snap-review',
        approvedSnapshotId: null,
      }),
    ).toBe('snap-review');
  });

  it('FINAL desce a cadeia inteira até achar um snapshot', () => {
    expect(
      resolveFrozenSnapshotId('FINAL', {
        reviewSnapshotId: 'snap-review',
        approvedSnapshotId: null,
        finalSnapshotId: null,
      }),
    ).toBe('snap-review');
  });

  it('sem nenhum snapshot retorna null (a rota vira 404, nunca documento vivo)', () => {
    expect(
      resolveFrozenSnapshotId('FINAL', {
        reviewSnapshotId: null,
        approvedSnapshotId: null,
        finalSnapshotId: null,
      }),
    ).toBeNull();
  });
});
