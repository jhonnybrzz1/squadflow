/**
 * Testes do Request Budget — teto global da cascata retry × fallback.
 *
 * Valida que o budget:
 * 1. Aborta a cascata quando o deadline expira
 * 2. Limita tentativas totais (não 3-por-nível sem limite)
 * 3. Reduz o timeout por chamada ao remaining time quando budget < timeout
 * 4. Não interfere quando não fornecido (backward compat)
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createFallbackBudget,
  createRequestBudget,
  consumeAttempt,
  disposeRequestBudget,
  isBudgetExpired,
  getRemainingMs,
  isGlobalBudgetExpired,
} from '../server/services/request-budget';
import { withRetry, DEFAULT_RETRY_CONFIG } from '../server/services/llm-retry-handler';

describe('RequestBudget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cria budget com deadline e controller', () => {
    const budget = createRequestBudget(1000, 6);
    expect(budget.budgetMs).toBe(1000);
    expect(budget.maxTotalAttempts).toBe(6);
    expect(budget.attemptsUsed.count).toBe(0);
    expect(budget.controller.signal.aborted).toBe(false);
    expect(budget.deadlineMs).toBeGreaterThan(Date.now());
  });

  it('consumeAttempt incrementa o contador e lança ao exceder teto', () => {
    const budget = createRequestBudget(10000, 3);
    consumeAttempt(budget, 'test1');
    consumeAttempt(budget, 'test2');
    consumeAttempt(budget, 'test3');
    expect(budget.attemptsUsed.count).toBe(3);
    expect(() => consumeAttempt(budget, 'test4')).toThrow(/budget exhausted/i);
  });

  it('isBudgetExpired detecta deadline passado', () => {
    const budget = createRequestBudget(100, 6);
    expect(isBudgetExpired(budget)).toBe(false);
    vi.advanceTimersByTime(150);
    expect(isBudgetExpired(budget)).toBe(true);
  });

  it('getRemainingMs retorna tempo restante até o deadline', () => {
    const budget = createRequestBudget(1000, 6);
    expect(getRemainingMs(budget)).toBeCloseTo(1000, -2);
    vi.advanceTimersByTime(300);
    expect(getRemainingMs(budget)).toBeCloseTo(700, -2);
  });

  it('budget undefined não lança nem bloqueia (backward compat)', () => {
    expect(() => consumeAttempt(undefined, 'test')).not.toThrow();
    expect(isBudgetExpired(undefined)).toBe(false);
    expect(getRemainingMs(undefined)).toBe(Number.POSITIVE_INFINITY);
  });

  it('auto-aborta via setTimeout quando deadline expira', () => {
    const budget = createRequestBudget(100, 6);
    expect(budget.controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(100);
    expect(budget.controller.signal.aborted).toBe(true);
  });

  it('cria fallback com controller novo, tentativas compartilhadas e teto global preservado', () => {
    const primary = createRequestBudget(120_000, 6, 60_000);
    consumeAttempt(primary, 'primary');

    vi.advanceTimersByTime(60_000);
    expect(primary.controller.signal.aborted).toBe(true);
    expect(isGlobalBudgetExpired(primary)).toBe(false);

    const fallback = createFallbackBudget(primary, 'explicit');
    expect(fallback.controller).not.toBe(primary.controller);
    expect(fallback.controller.signal.aborted).toBe(false);
    expect(fallback.globalDeadlineMs).toBe(primary.globalDeadlineMs);
    expect(fallback.deadlineMs).toBe(primary.globalDeadlineMs);
    expect(fallback.attemptsUsed).toBe(primary.attemptsUsed);
    expect(fallback.attemptsUsed.count).toBe(1);

    disposeRequestBudget(fallback);
  });

  it('limita o fallback ao tempo restante do teto global', () => {
    const primary = createRequestBudget(100, 6, 60);
    vi.advanceTimersByTime(60);

    const fallback = createFallbackBudget(primary, 'provider');
    expect(getRemainingMs(fallback)).toBe(40);

    vi.advanceTimersByTime(40);
    expect(isBudgetExpired(fallback)).toBe(true);
    expect(isGlobalBudgetExpired(fallback)).toBe(true);
  });

  it('dispose limpa timer sem abortar operação já concluída', () => {
    const budget = createRequestBudget(100, 6, 60);
    disposeRequestBudget(budget);

    vi.advanceTimersByTime(100);
    expect(budget.controller.signal.aborted).toBe(false);
  });
});

describe('withRetry + RequestBudget', () => {
  it('aborta retry quando teto de tentativas totais é excedido', async () => {
    const budget = createRequestBudget(10000, 2);
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(
      withRetry(
        fn,
        { ...DEFAULT_RETRY_CONFIG, maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 },
        budget,
      ),
    ).rejects.toThrow(/budget exhausted/i);

    // Deve ter tentado apenas 2 vezes (teto), não 3 (maxAttempts por nível)
    expect(fn).toHaveBeenCalledTimes(2);
    // A 3ª consumeAttempt incrementa o count antes de lançar (count=3, teto=2)
    expect(budget.attemptsUsed.count).toBe(3);
  });

  it('aborta retry quando deadline expira entre tentativas', async () => {
    const budget = createRequestBudget(50, 100);
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    vi.useFakeTimers();
    const promise = withRetry(
      fn,
      { ...DEFAULT_RETRY_CONFIG, maxAttempts: 10, initialDelayMs: 100, maxDelayMs: 100 },
      budget,
    );
    vi.advanceTimersByTime(200);
    await expect(promise).rejects.toThrow();
    vi.useRealTimers();

    // Não deve ter tentado todas as 10 — budget abortou
    expect(fn.mock.calls.length).toBeLessThan(10);
  });

  it('passa quando retry sucede dentro do budget', async () => {
    const budget = createRequestBudget(10000, 6);
    const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue('success');

    const result = await withRetry(
      fn,
      { ...DEFAULT_RETRY_CONFIG, maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 },
      budget,
    );
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(budget.attemptsUsed.count).toBe(2);
  });

  it('sem budget, retry comporta como antes (3 tentativas)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('success');

    const result = await withRetry(fn, {
      ...DEFAULT_RETRY_CONFIG,
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 1,
    });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
