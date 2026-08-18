/**
 * Spec 10015 US4 — go-live-scope: fail-safe (ausente ⇒ modo COMPLETO) e limpeza
 * em `finally` para não vazar estado entre demandas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  beginGoLiveScope,
  endGoLiveScope,
  isDemandGoLive,
  resetGoLiveScopes,
} from '../../server/services/go-live-scope';

beforeEach(() => resetGoLiveScopes());

describe('go-live-scope (spec 10015 US4)', () => {
  it('isDemandGoLive retorna false quando a demanda não está registrada (fail-safe)', () => {
    expect(isDemandGoLive(99999)).toBe(false);
    expect(isDemandGoLive(null)).toBe(false);
    expect(isDemandGoLive(undefined)).toBe(false);
  });

  it('registra e desregistra a demanda como go-live', () => {
    beginGoLiveScope(100, true);
    expect(isDemandGoLive(100)).toBe(true);
    endGoLiveScope(100);
    expect(isDemandGoLive(100)).toBe(false);
  });

  it('beginGoLiveScope(false) não registra (opt-in explícito)', () => {
    beginGoLiveScope(101, false);
    expect(isDemandGoLive(101)).toBe(false);
  });

  it('endGoLiveScope é idempotente (chamar sem begin não quebra)', () => {
    expect(() => endGoLiveScope(102)).not.toThrow();
  });

  it('não vaza estado entre demandas (escopo isolado por demandId)', () => {
    beginGoLiveScope(200, true);
    expect(isDemandGoLive(200)).toBe(true);
    expect(isDemandGoLive(201)).toBe(false);
    endGoLiveScope(200);
    expect(isDemandGoLive(200)).toBe(false);
  });
});
