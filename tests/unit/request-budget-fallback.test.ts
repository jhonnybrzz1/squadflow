/**
 * Spec 028 (T1 G-05 / T4) — cascata de fallback com budget wall-clock.
 *
 * Defeito O-01: `AI_CHAT_TIMEOUT_MS` (120s) era IGUAL a `REQUEST_BUDGET_MS`
 * (120s), então uma única chamada consumia o budget global inteiro e o fallback
 * recebia ZERO tempo residual — 100% de erro no fallback em produção com a suíte
 * verde. A calibragem da T4 põe o timeout por chamada como fração do budget.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import {
  createRequestBudget,
  createFallbackBudget,
  getRemainingMs,
  consumeAttempt,
} from '../../server/services/request-budget';

function loadRealEnv(): NodeJS.ProcessEnv {
  const envPath = resolve(__dirname, '../../.env');
  if (!existsSync(envPath)) return { ...process.env };
  return { ...process.env, ...dotenv.parse(readFileSync(envPath)) };
}

function num(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const v = Number.parseInt(env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

describe('Spec 028 G-05 — timeout por chamada deixa tempo para o fallback', () => {
  it('AI_CHAT_TIMEOUT_MS cabe ≥2× dentro do REQUEST_BUDGET_MS (fallback tem vez)', () => {
    const env = loadRealEnv();
    const perCall = num(env, 'AI_CHAT_TIMEOUT_MS', 120_000);
    const budget = num(env, 'REQUEST_BUDGET_MS', 120_000);
    // ≥2 tentativas completas devem caber no budget global.
    expect(
      perCall * 2,
      `AI_CHAT_TIMEOUT_MS=${perCall} não deixa margem p/ 2 tentativas em REQUEST_BUDGET_MS=${budget}`,
    ).toBeLessThanOrEqual(budget);
    // E estritamente menor que o budget (nunca igual).
    expect(perCall).toBeLessThan(budget);
  });

  it('após o estágio primário, o fallback recebe tempo residual > 0', () => {
    // Budget curto mas com timeout por chamada menor: sobra tempo p/ o fallback.
    const b = createRequestBudget(2000, 6, 800);
    const primaryWindow = getRemainingMs(b);
    expect(primaryWindow).toBeGreaterThan(0);
    const fb = createFallbackBudget(b, 'economic');
    expect(getRemainingMs(fb)).toBeGreaterThan(0);
  });

  it('distingue "fallback nunca tentado" de "tentou e esgotou" (T4)', () => {
    // Esgota o teto de tentativas → mensagem de "exhausted" (tentou).
    const b = createRequestBudget(60_000, 1, 60_000);
    consumeAttempt(b, 'primary'); // 1ª tentativa ok
    expect(() => consumeAttempt(b, 'fallback')).toThrow(/exhausted/i);

    // Budget global já expirado → mensagem de "expired before" (nunca tentou).
    const expired = createRequestBudget(1, 6, 1);
    // Espera o deadline de 1ms passar.
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* busy wait curto e determinístico */
    }
    expect(() => consumeAttempt(expired, 'fallback')).toThrow(/expired before/i);
  });
});
