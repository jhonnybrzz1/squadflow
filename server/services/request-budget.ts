/**
 * Request Budget — teto global wall-clock por request LLM.
 *
 * PROBLEMA: retry (3×) × fallback em cascata (4 níveis) × timeout por chamada
 * (120s) sem teto global = pior caso de ~6min + N× custo numa falha em cascata.
 * Cada mecanismo é OK isolado; a composição é ilimitada.
 *
 * FIX: um deadline wall-clock global com janelas descartáveis por estágio.
 * Primária e fallbacks recebem AbortControllers próprios, mas compartilham o
 * teto global e o contador total de tentativas.
 *
 * Padrão: REQUEST_BUDGET_MS=120000 (120s) no total e
 * REQUEST_STAGE_BUDGET_MS=60000 (60s) por estágio.
 *
 * Também impõe um teto de TENTATIVAS TOTAIS (não 3-por-nível sem limite):
 * REQUEST_MAX_TOTAL_ATTEMPTS=6. Mesmo com budget sobrando, não deixa a cascata
 * multiplicar tentativas além de um teto absoluto.
 */
import { logger } from '../utils/logger';

export type BudgetStage = 'primary' | 'explicit' | 'economic' | 'provider' | 'governance';

export interface RequestBudget {
  /** Deadline wall-clock absoluto do estágio atual. */
  deadlineMs: number;
  /** Deadline wall-clock absoluto da operação completa. */
  globalDeadlineMs: number;
  /** AbortController exclusivo do estágio atual. */
  controller: AbortController;
  /** Timer exclusivo do estágio atual; limpo por disposeRequestBudget. */
  timer?: ReturnType<typeof setTimeout>;
  /** Número máximo de tentativas totais na cascata inteira. */
  maxTotalAttempts: number;
  /** Contador de tentativas já consumidas (mutável, compartilhado por referência). */
  attemptsUsed: { count: number };
  /** Teto global original em ms (para telemetria). */
  budgetMs: number;
  /** Janela máxima configurada para cada estágio. */
  stageBudgetMs: number;
  /** Estágio representado por este controller/deadline. */
  stage: BudgetStage;
}

/**
 * Cria um budget para um request. O deadline expira automaticamente via setTimeout.
 */
export function createRequestBudget(
  budgetMs: number = parsePositiveIntEnv('REQUEST_BUDGET_MS', 120_000),
  maxTotalAttempts: number = parsePositiveIntEnv('REQUEST_MAX_TOTAL_ATTEMPTS', 10),
  stageBudgetMs: number = parsePositiveIntEnv('REQUEST_STAGE_BUDGET_MS', 60_000),
): RequestBudget {
  const now = Date.now();
  return createBudgetStage({
    globalDeadlineMs: now + budgetMs,
    maxTotalAttempts,
    attemptsUsed: { count: 0 },
    budgetMs,
    stageBudgetMs,
    stage: 'primary',
  });
}

/**
 * Finaliza o estágio atual e cria uma janela independente para o fallback.
 * O teto global e o contador de tentativas permanecem compartilhados.
 */
export function createFallbackBudget(
  current: RequestBudget,
  stage: Exclude<BudgetStage, 'primary'>,
): RequestBudget {
  disposeRequestBudget(current);
  return createBudgetStage({
    globalDeadlineMs: current.globalDeadlineMs,
    maxTotalAttempts: current.maxTotalAttempts,
    attemptsUsed: current.attemptsUsed,
    budgetMs: current.budgetMs,
    stageBudgetMs: current.stageBudgetMs,
    stage,
  });
}

/** Limpa o timer do estágio sem abortar uma operação já concluída. */
export function disposeRequestBudget(budget: RequestBudget | undefined): void {
  if (!budget?.timer) return;
  clearTimeout(budget.timer);
  budget.timer = undefined;
}

function createBudgetStage(input: {
  globalDeadlineMs: number;
  maxTotalAttempts: number;
  attemptsUsed: { count: number };
  budgetMs: number;
  stageBudgetMs: number;
  stage: BudgetStage;
}): RequestBudget {
  const controller = new AbortController();
  const now = Date.now();
  const deadlineMs = Math.min(now + input.stageBudgetMs, input.globalDeadlineMs);
  const effectiveBudgetMs = Math.max(0, deadlineMs - now);

  const budget: RequestBudget = {
    deadlineMs,
    globalDeadlineMs: input.globalDeadlineMs,
    controller,
    maxTotalAttempts: input.maxTotalAttempts,
    attemptsUsed: input.attemptsUsed,
    budgetMs: input.budgetMs,
    stageBudgetMs: input.stageBudgetMs,
    stage: input.stage,
  };

  if (effectiveBudgetMs === 0) {
    controller.abort(new Error(`Request budget expired before stage ${input.stage}`));
    return budget;
  }

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      logger.warn(`Request budget expired (${effectiveBudgetMs}ms) — aborting stage`, {
        context: {
          budgetMs: input.budgetMs,
          stageBudgetMs: effectiveBudgetMs,
          stage: input.stage,
          deadlineMs,
          globalDeadlineMs: input.globalDeadlineMs,
        },
      });
      controller.abort(
        new Error(`Request budget expired after ${effectiveBudgetMs}ms (stage=${input.stage})`),
      );
    }
  }, effectiveBudgetMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  budget.timer = timer;

  return budget;
}

/**
 * Verifica se o budget já expirou. Não lança — deixa o caller decidir.
 */
export function isBudgetExpired(budget: RequestBudget | undefined): boolean {
  if (!budget) return false;
  const now = Date.now();
  return (
    now >= budget.deadlineMs || now >= budget.globalDeadlineMs || budget.controller.signal.aborted
  );
}

/** Indica se o teto global acabou, independentemente da janela do estágio atual. */
export function isGlobalBudgetExpired(budget: RequestBudget | undefined): boolean {
  if (!budget) return false;
  return Date.now() >= budget.globalDeadlineMs;
}

/**
 * Registra uma tentativa no budget. Lança se excedeu o teto de tentativas totais
 * ou se o deadline já expirou. Use no início de cada tentativa de retry/fallback.
 */
export function consumeAttempt(budget: RequestBudget | undefined, contextLabel: string): void {
  if (!budget) return;

  if (isBudgetExpired(budget)) {
    throw new Error(
      `Request budget expired before ${contextLabel} (deadline ${budget.deadlineMs})`,
    );
  }

  budget.attemptsUsed.count++;
  if (budget.attemptsUsed.count > budget.maxTotalAttempts) {
    throw new Error(
      `Request budget exhausted: ${budget.attemptsUsed.count} attempts > ${budget.maxTotalAttempts} max (at ${contextLabel})`,
    );
  }
}

/**
 * Tempo restante em ms antes do deadline expirar (mínimo 0).
 */
export function getRemainingMs(budget: RequestBudget | undefined): number {
  if (!budget) return Number.POSITIVE_INFINITY;
  const effectiveDeadline = Math.min(budget.deadlineMs, budget.globalDeadlineMs);
  return Math.max(0, effectiveDeadline - Date.now());
}

/**
 * Helper para parsear env vars positivas inteiras (evita dependência circular
 * com llm-retry-handler).
 */
function parsePositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
