/**
 * Spec 10039 T9 — N de self-consistency configurável (otimização de custo).
 * Precedência: options.n explícito > SELF_CONSISTENCY_N (env) > default 2.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveSelfConsistencyN,
  DEFAULT_SELF_CONSISTENCY_N,
} from '../../server/services/ai-squad/self-consistency-runner';

const original = process.env.SELF_CONSISTENCY_N;

afterEach(() => {
  if (original === undefined) delete process.env.SELF_CONSISTENCY_N;
  else process.env.SELF_CONSISTENCY_N = original;
});

describe('Spec 10039 T9 — resolveSelfConsistencyN', () => {
  it('default é 2 quando nada configurado', () => {
    delete process.env.SELF_CONSISTENCY_N;
    expect(DEFAULT_SELF_CONSISTENCY_N).toBe(2);
    expect(resolveSelfConsistencyN()).toBe(2);
  });

  it('lê SELF_CONSISTENCY_N do env', () => {
    process.env.SELF_CONSISTENCY_N = '3';
    expect(resolveSelfConsistencyN()).toBe(3);
  });

  it('options.n explícito precede o env', () => {
    process.env.SELF_CONSISTENCY_N = '2';
    expect(resolveSelfConsistencyN(3)).toBe(3);
  });

  it('env inválido cai no default 2', () => {
    process.env.SELF_CONSISTENCY_N = 'abc';
    expect(resolveSelfConsistencyN()).toBe(2);
    process.env.SELF_CONSISTENCY_N = '0';
    expect(resolveSelfConsistencyN()).toBe(2);
  });

  it('valores fracionários são truncados', () => {
    expect(resolveSelfConsistencyN(3.9)).toBe(3);
  });
});
