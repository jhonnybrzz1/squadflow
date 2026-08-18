/**
 * Demanda 10089 (item 2) — causa técnica obrigatória para stopped/error.
 */
import { describe, it, expect } from 'vitest';
import {
  FAILURE_CATEGORIES,
  failureReasonSchema,
  FAILURE_CATEGORY_LABELS,
} from '../../shared/failure-category';

describe('failureReasonSchema', () => {
  it('aceita as 6 categorias definidas', () => {
    expect(FAILURE_CATEGORIES).toHaveLength(6);
    for (const c of FAILURE_CATEGORIES) {
      if (c === 'OUTRO') continue;
      expect(failureReasonSchema.safeParse({ failureCategory: c }).success).toBe(true);
    }
  });

  it('rejeita categoria fora do enum', () => {
    expect(failureReasonSchema.safeParse({ failureCategory: 'INVENTADA' }).success).toBe(false);
  });

  it('rejeita null/ausente (causa é obrigatória)', () => {
    expect(failureReasonSchema.safeParse({}).success).toBe(false);
    expect(failureReasonSchema.safeParse({ failureCategory: null }).success).toBe(false);
  });

  it('OUTRO sem otherDetail é rejeitado; com detalhe é aceito', () => {
    expect(failureReasonSchema.safeParse({ failureCategory: 'OUTRO' }).success).toBe(false);
    const ok = failureReasonSchema.safeParse({
      failureCategory: 'OUTRO',
      otherDetail: 'provedor fora do ar',
    });
    expect(ok.success).toBe(true);
  });

  it('OUTRO com detalhe só de espaços é rejeitado (não burla a categorização)', () => {
    expect(
      failureReasonSchema.safeParse({ failureCategory: 'OUTRO', otherDetail: '   ' }).success,
    ).toBe(false);
  });

  it('todas as categorias têm rótulo de UI', () => {
    for (const c of FAILURE_CATEGORIES) expect(FAILURE_CATEGORY_LABELS[c]).toBeTruthy();
  });
});
