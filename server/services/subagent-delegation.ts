/**
 * Demanda 10100 — Subagent delegation service.
 *
 * Mantém estado em memória por coordenador: semaphore de subagentes simultâneos
 * e acumulador de custo estimado por delegação. Os mapas são reinicializados a
 * cada ciclo de vida do processo (escopo deliberado do MVP).
 *
 * @deprecated Triagem de dead code de 2026-08-07 (#10277): nenhum arquivo de
 * produção importa este módulo — só `tests/unit/subagent-delegation.test.ts`.
 * A delegação a subagentes nunca foi ligada ao orquestrador. Não foi removido
 * aqui porque tem cobertura de teste e remover módulo inteiro exige demanda
 * própria; ver `docs/dead-exports-triage-2026-08-07.md`. Antes de construir em
 * cima dele, confirmar que a decisão é reativar e não excluir.
 */
import { getCachedPricing } from './openrouter-pricing';
import { featureFlags } from './feature-flags';
import { aiUsageTracker } from './ai-usage-tracker';
import { logger } from '../utils/logger';

export interface DelegationError {
  code: 'DEPTH_LIMIT' | 'DELEGATION_LIMIT' | 'DELEGATION_COST_LIMIT';
  maxDepth?: number;
  maxConcurrent?: number;
  maxCost?: number;
  accumulated?: number;
}

export interface DelegationRequest {
  coordinatorId: string;
  subagentName: string;
  model: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  isSubagent: boolean;
}

export interface DelegationResult {
  ok: boolean;
  error?: DelegationError;
  estimatedCost?: number;
}

const MAX_DEPTH = 1;
const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_COST = 2.0;

// Estado em memória por coordenador.
const concurrentCounts = new Map<string, number>();
const costAccumulators = new Map<string, number>();

export function resetSubagentStateForTests(): void {
  concurrentCounts.clear();
  costAccumulators.clear();
}

function getMaxConcurrent(): number {
  try {
    const flags = featureFlags.getFlags();
    const value = flags?.maxConcurrentSubagents;
    return typeof value === 'number' && value > 0 ? value : DEFAULT_MAX_CONCURRENT;
  } catch {
    return DEFAULT_MAX_CONCURRENT;
  }
}

function getMaxCost(): number {
  try {
    const flags = featureFlags.getFlags();
    const value = flags?.maxDelegationCostPerTask;
    return typeof value === 'number' && value > 0 ? value : DEFAULT_MAX_COST;
  } catch {
    return DEFAULT_MAX_COST;
  }
}

function isDelegationEnabled(): boolean {
  try {
    const flags = featureFlags.getFlags();
    return flags?.enableSubagentDelegation === true;
  } catch {
    return false;
  }
}

async function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): Promise<number> {
  const pricing = await getCachedPricing(model);
  if (pricing) {
    return (
      (inputTokens * pricing.inputUsdPer1M + outputTokens * pricing.outputUsdPer1M) / 1_000_000
    );
  }
  // Fallback conservador quando preço não está disponível.
  return ((inputTokens + outputTokens) / 1_000_000) * 0.5;
}

/**
 * Tenta iniciar uma delegação. Se aprovada, incrementa o semaphore e o
 * acumulador de custo. O caller DEVE chamar `releaseSubagent(coordinatorId)`
 * no finally/catch da execução.
 */
export async function requestDelegation(request: DelegationRequest): Promise<DelegationResult> {
  if (!isDelegationEnabled()) {
    return { ok: false, error: { code: 'DEPTH_LIMIT', maxDepth: MAX_DEPTH } };
  }

  if (request.isSubagent) {
    return { ok: false, error: { code: 'DEPTH_LIMIT', maxDepth: MAX_DEPTH } };
  }

  const maxConcurrent = getMaxConcurrent();
  const currentCount = concurrentCounts.get(request.coordinatorId) ?? 0;
  if (currentCount >= maxConcurrent) {
    return {
      ok: false,
      error: { code: 'DELEGATION_LIMIT', maxConcurrent },
    };
  }

  const maxCost = getMaxCost();
  const accumulated = costAccumulators.get(request.coordinatorId) ?? 0;
  const estimatedCost = await estimateCost(
    request.model,
    request.estimatedInputTokens,
    request.estimatedOutputTokens,
  );

  if (accumulated + estimatedCost > maxCost) {
    return {
      ok: false,
      error: { code: 'DELEGATION_COST_LIMIT', maxCost, accumulated },
    };
  }

  concurrentCounts.set(request.coordinatorId, currentCount + 1);
  costAccumulators.set(request.coordinatorId, accumulated + estimatedCost);

  logger.info('Subagent delegation approved', {
    context: {
      coordinatorId: request.coordinatorId,
      subagentName: request.subagentName,
      estimatedCost,
      accumulated: accumulated + estimatedCost,
      concurrent: currentCount + 1,
    },
  });

  return { ok: true, estimatedCost };
}

/**
 * Libera um slot do semaphore. O custo acumulado permanece (é cumulativo por ciclo).
 */
export function releaseSubagent(coordinatorId: string): void {
  const currentCount = concurrentCounts.get(coordinatorId) ?? 0;
  if (currentCount > 0) {
    concurrentCounts.set(coordinatorId, currentCount - 1);
  }
}

/**
 * Registra tokens reais consumidos por um subagente. Acumula no custo real
 * quando preço disponível; registra no aiUsageTracker com tags delegation=true
 * e depth=1 para distinção de chamadas normais.
 *
 * @deprecated Dead-code-report-AiChatFlow1-2026-07-28 (demanda #10269):
 * função sem caller confirmado; preservada para decisão futura. TODO: remover
 * ou reintegrar ao registro de subagentes.
 */
export async function recordSubagentTokens(
  coordinatorId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): Promise<number> {
  const actualCost = await estimateCost(model, inputTokens, outputTokens);
  const accumulated = costAccumulators.get(coordinatorId) ?? 0;
  // No MVP somamos o custo real ao acumulado (o estimated foi reservado na
  // aprovação; aqui usamos o actual para observabilidade).
  costAccumulators.set(coordinatorId, accumulated + actualCost);

  aiUsageTracker.record({
    timestamp: new Date().toISOString(),
    demandId: Number(coordinatorId) || undefined,
    operation: 'subagent:completion',
    model,
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCostUsd: actualCost,
    cacheHit: false,
    estimatedTokensSaved: 0,
    estimatedCostSavedUsd: null,
    latencyMs: 0,
    delegation: true,
    depth: 1,
    // M-2: subagent calls are tracked under a dedicated agent/stage.
    agentId: 'agent:subagent',
    stage: 'delegation',
  });

  return actualCost;
}
