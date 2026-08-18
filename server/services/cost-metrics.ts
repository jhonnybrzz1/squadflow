/**
 * Cost Metrics Service
 *
 * Aggregates and provides cost optimization metrics for monitoring.
 * Returns metrics for recent windows and baseline comparisons.
 */

import { aiUsageTracker } from './ai-usage-tracker';
import { aiResponseCache } from './ai-cache';
import { metricsCollector } from '../metrics/collector';
import { setKillSwitchState, getKillSwitchState } from './cost-routing';
// Demanda 10093: percentil com guarda de amostra + custo com unidade explícita.
import {
  percentileWithGuard,
  formatCost,
  decomposeBy,
  type PercentileResult,
  type CostDisplay,
  type Decomposition,
} from './metrics-presentation';
import { logger } from '../utils/logger';

export interface CostMetricsWindow {
  start: string;
  end: string;
  durationMs: number;
}

export interface CostMetrics {
  timestamp: string;
  window: CostMetricsWindow;
  baseline: {
    period: string;
    avgCostPerRequest: number;
    totalRequests: number;
  };
  current: {
    avgCostPerRequest: number;
    totalRequests: number;
    changeFromBaseline: number;
    changePercent: number;
  };
  routing: {
    economicRate: number;
    safeRate: number;
    unknownRate: number;
    fallbackRate: number;
    economicCount: number;
    safeCount: number;
    unknownCount: number;
    fallbackCount: number;
  };
  cache: {
    hitRate: number;
    totalHits: number;
    totalMisses: number;
    estimatedCostSaved: number;
  };
  quality: {
    errorRate: number;
    timeoutRate: number;
    emptyResponseRate: number;
  };
  latency: {
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
  /**
   * Demanda 10093: percentis com guarda de amostra (n<10 => `insufficientSample`,
   * valor null). Os campos legados acima seguem para não quebrar consumidores.
   */
  latencyGuarded: {
    p50: PercentileResult;
    p95: PercentileResult;
    p99: PercentileResult;
  };
  /** Custo total nas duas unidades — 0.002 USD é 2 mUSD, não 2 centavos. */
  costDisplay: CostDisplay;
  /** Decomposição de custo/latência por modelo e por operação. */
  decomposition: {
    byModel: Decomposition[];
    byOperation: Decomposition[];
  };
  killSwitch: {
    active: boolean;
    disabledComponent: 'routing' | 'cache' | null;
    triggerReason: string | null;
    triggeredAt: string | null;
  };
}

/**
 * Get metrics for a recent time window
 */
function getWindowMetrics(_windowMs: number): {
  totalRequests: number;
  totalCost: number;
  avgCost: number;
} {
  const summary = aiUsageTracker.getSummary();
  const records = summary.recent;

  // For now, we use all recent records as the "window"
  // In production, this would be filtered by timestamp
  const windowRecords = records.slice(-100); // Last 100 records as proxy for window

  if (windowRecords.length === 0) {
    return {
      totalRequests: 0,
      totalCost: 0,
      avgCost: 0,
    };
  }

  const totalCost = windowRecords.reduce((sum, r) => sum + (r.estimatedCostUsd || 0), 0);
  const avgCost = totalCost / windowRecords.length;

  return {
    totalRequests: windowRecords.length,
    totalCost,
    avgCost,
  };
}

/**
 * Get baseline metrics from real usage records when available,
 * fallback to conservative defaults.
 * NOTE: Para baseline de 30 dias real, persistir registros no banco
 * e consultar via query SQL (próxima fase).
 */
function getBaselineMetrics(): {
  avgCostPerRequest: number;
  totalRequests: number;
} {
  const summary = aiUsageTracker.getSummary();
  const nonCacheRecords = summary.recent.filter((r) => !r.cacheHit && r.estimatedCostUsd !== null);

  // Se temos registros reais suficientes (mínimo 20), usa a média móvel como baseline
  if (nonCacheRecords.length >= 20) {
    const totalCost = nonCacheRecords.reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0);
    const avgCost = totalCost / nonCacheRecords.length;
    return {
      avgCostPerRequest: avgCost,
      totalRequests: summary.requestCount,
    };
  }

  // Fallback conservador: $0.001/req (documenta que é estimativa)
  return {
    avgCostPerRequest: 0.001,
    totalRequests: summary.requestCount || 1000,
  };
}

/**
 * Calculate kill-switch status
 */
function calculateKillSwitchStatus(): {
  active: boolean;
  disabledComponent: 'routing' | 'cache' | null;
  triggerReason: string | null;
  triggeredAt: string | null;
} {
  const currentMetrics = getWindowMetrics(15 * 60 * 1000); // 15 minutes
  const baseline = getBaselineMetrics();

  const thresholdMultiplier = parseFloat(process.env.KILL_SWITCH_THRESHOLD || '1.1');
  const currentAvgCost = currentMetrics.avgCost;
  const baselineAvgCost = baseline.avgCostPerRequest;

  // Get current kill-switch state
  const currentState = getKillSwitchState();

  // Kill-switch triggers if current cost > threshold * baseline
  const shouldTrigger =
    currentAvgCost > baselineAvgCost * thresholdMultiplier && currentMetrics.totalRequests > 10;

  if (shouldTrigger && !currentState.active) {
    const spikeRatio = (currentAvgCost / baselineAvgCost).toFixed(2);
    logger.warn('Cost spike detected — kill-switch activating', {
      context: {
        currentAvgCostUsd: currentAvgCost.toFixed(6),
        baselineAvgCostUsd: baselineAvgCost.toFixed(6),
        spikeRatio,
        thresholdMultiplier,
        totalRequestsInWindow: currentMetrics.totalRequests,
      },
    });
    // Activate kill-switch
    setKillSwitchState(true, 'routing', `cost_spike_${spikeRatio}x_baseline`);
  } else if (!shouldTrigger && currentState.active) {
    logger.info('Cost spike resolved — kill-switch deactivating', {
      context: {
        currentAvgCostUsd: currentAvgCost.toFixed(6),
        baselineAvgCostUsd: baselineAvgCost.toFixed(6),
      },
    });
    // Deactivate kill-switch (cooldown period could be added here)
    setKillSwitchState(false);
  }

  // Get current state from routing service
  return getKillSwitchState();
}

/**
 * Get comprehensive cost metrics
 */
export function getCostMetrics(windowMs: number = 15 * 60 * 1000): CostMetrics {
  const summary = aiUsageTracker.getSummary();
  const cacheStats = aiResponseCache.getStats();
  const openAiStats = metricsCollector.getOpenAIStats();
  const windowMetrics = getWindowMetrics(windowMs);
  const baseline = getBaselineMetrics();
  const killSwitchStatus = calculateKillSwitchStatus();

  // Demanda 10093: base para decomposição e percentis guardados.
  const recentRecords = summary.recent;
  const latencies = recentRecords
    .map((r) => r.latencyMs)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  const changeFromBaseline = windowMetrics.avgCost - baseline.avgCostPerRequest;
  const changePercent =
    baseline.avgCostPerRequest > 0 ? (changeFromBaseline / baseline.avgCostPerRequest) * 100 : 0;

  const totalRoutedRequests = summary.routing.economicCount + summary.routing.safeCount;
  const fallbackRate =
    totalRoutedRequests > 0 ? summary.routing.fallbackCount / totalRoutedRequests : 0;

  return {
    timestamp: new Date().toISOString(),
    window: {
      start: new Date(Date.now() - windowMs).toISOString(),
      end: new Date().toISOString(),
      durationMs: windowMs,
    },
    baseline: {
      period: '7d',
      avgCostPerRequest: baseline.avgCostPerRequest,
      totalRequests: baseline.totalRequests,
    },
    current: {
      avgCostPerRequest: windowMetrics.avgCost,
      totalRequests: windowMetrics.totalRequests,
      changeFromBaseline,
      changePercent,
    },
    routing: {
      economicRate:
        totalRoutedRequests > 0 ? summary.routing.economicCount / totalRoutedRequests : 0,
      safeRate: totalRoutedRequests > 0 ? summary.routing.safeCount / totalRoutedRequests : 0,
      unknownRate: totalRoutedRequests > 0 ? summary.routing.unknownCount / totalRoutedRequests : 0,
      fallbackRate,
      economicCount: summary.routing.economicCount,
      safeCount: summary.routing.safeCount,
      unknownCount: summary.routing.unknownCount,
      fallbackCount: summary.routing.fallbackCount,
    },
    cache: {
      hitRate: cacheStats.hitRate,
      totalHits: cacheStats.totalHits,
      totalMisses: cacheStats.totalMisses,
      estimatedCostSaved: summary.estimatedCostSavedUsd || 0,
    },
    quality: {
      // For MVP, we use OpenAI error rate as proxy
      errorRate: 0, // Would be calculated from error logs
      timeoutRate: 0, // Would be calculated from timeout logs
      emptyResponseRate: 0, // Would be calculated from empty response logs
    },
    latency: {
      avgMs: openAiStats.avgLatencyMs,
      p50Ms: openAiStats.p50LatencyMs,
      p95Ms: openAiStats.p95LatencyMs,
      p99Ms: 0, // Not available from current stats
    },
    // Demanda 10093: mesma latência, agora dizendo quando a amostra não sustenta
    // o percentil, em vez de exibir um número com falsa aparência de rigor.
    latencyGuarded: {
      p50: percentileWithGuard(latencies, 50),
      p95: percentileWithGuard(latencies, 95),
      p99: percentileWithGuard(latencies, 99),
    },
    costDisplay: formatCost(windowMetrics.totalCost),
    decomposition: {
      byModel: decomposeBy(
        recentRecords,
        (r) => r.modelAlias ?? r.model,
        (r) => r.estimatedCostUsd,
        (r) => r.latencyMs,
      ),
      byOperation: decomposeBy(
        recentRecords,
        (r) => r.operation,
        (r) => r.estimatedCostUsd,
        (r) => r.latencyMs,
      ),
    },
    killSwitch: killSwitchStatus,
  };
}

// `isKillSwitchActive(component)` foi removida na triagem de 2026-08-07 (#10277).
// Não tinha caller e era uma armadilha: o nome prometia leitura, mas ela chamava
// `calculateKillSwitchStatus()`, que muta estado global via `setKillSwitchState()`.
// Quem precisa saber se o kill-switch está ativo já é atendido: o ponto de
// decisão consulta as variáveis diretamente em `cost-routing.ts:126-134`, e a
// rota de admin lê o estado por `getKillSwitchState()`.
