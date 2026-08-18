/**
 * Demanda 10093 — amostra insuficiente em percentis e unidades de custo.
 */
import { describe, it, expect } from 'vitest';
import {
  percentileWithGuard,
  formatCost,
  decomposeBy,
  MIN_SAMPLE_FOR_PERCENTILE,
} from '../../server/services/metrics-presentation';

describe('percentileWithGuard — n<10 não vira estatística', () => {
  it('amostra pequena devolve null + insufficientSample (não um número falso)', () => {
    const r = percentileWithGuard([100, 900], 95);
    expect(r.value).toBeNull();
    expect(r.insufficientSample).toBe(true);
    expect(r.sampleSize).toBe(2);
  });

  it(`exatamente ${MIN_SAMPLE_FOR_PERCENTILE} amostras já calcula`, () => {
    const r = percentileWithGuard([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50);
    expect(r.insufficientSample).toBe(false);
    expect(r.value).toBeCloseTo(5.5);
  });

  it('p95 com interpolação linear', () => {
    const vals = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentileWithGuard(vals, 95).value).toBeCloseTo(95.05, 1);
  });

  it('ignora valores não-finitos ao medir a amostra', () => {
    const r = percentileWithGuard([1, NaN, 2, Infinity, 3], 50);
    expect(r.sampleSize).toBe(3);
    expect(r.insufficientSample).toBe(true);
  });
});

describe('formatCost — sem ambiguidade de unidade', () => {
  it('expõe USD e mUSD lado a lado', () => {
    expect(formatCost(0.002)).toEqual({ usd: 0.002, mUsd: 2 });
  });
  it('null/undefined viram zero, não NaN', () => {
    expect(formatCost(null)).toEqual({ usd: 0, mUsd: 0 });
    expect(formatCost(undefined)).toEqual({ usd: 0, mUsd: 0 });
  });
});

describe('decomposeBy — custo/latência por agente ou modelo', () => {
  const records = [
    { agent: 'tech_lead', cost: 0.01, ms: 100 },
    { agent: 'tech_lead', cost: 0.02, ms: 200 },
    { agent: 'qa', cost: 0.005, ms: 50 },
    { agent: null, cost: 1, ms: 1 }, // sem chave: ignorado
  ];

  it('agrupa, soma custo e ordena por custo desc', () => {
    const out = decomposeBy(
      records,
      (r) => r.agent,
      (r) => r.cost,
      (r) => r.ms,
    );
    expect(out.map((d) => d.key)).toEqual(['tech_lead', 'qa']);
    expect(out[0].totalCost.usd).toBeCloseTo(0.03);
    expect(out[0].totalCost.mUsd).toBeCloseTo(30);
    expect(out[0].avgLatencyMs).toBe(150);
  });

  it('cada grupo tem guarda própria — grupo pequeno não ganha p95', () => {
    const out = decomposeBy(
      records,
      (r) => r.agent,
      (r) => r.cost,
      (r) => r.ms,
    );
    expect(out.every((d) => d.p95LatencyMs.insufficientSample)).toBe(true);
    expect(out.every((d) => d.p95LatencyMs.value === null)).toBe(true);
  });
});
