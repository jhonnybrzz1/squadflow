/**
 * Health Check Service
 *
 * Fornece endpoints de health/readiness para monitoramento e orquestração.
 * Verifica estado de subsistemas críticos: DB, LLM clients, cache e RAG.
 */

import { dbHelper } from '../db';
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { llmClientManager } from './llm-client-manager';
import { aiResponseCache } from './ai-cache';
import { semanticCacheService } from './semantic-cache';
import { embeddingsManager } from './llm-embeddings-operations';
import { getGuardrailHealthState } from './llm-guardrails';
import { getAuditLossState } from './audit-loss-tracker';
import { getLastSchemaHealth } from './schema-health-check';

export interface SubsystemStatus {
  name: string;
  status: 'healthy' | 'unhealthy' | 'degraded';
  message?: string;
  latencyMs?: number;
}

export interface HealthCheckResult {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  version: string;
  subsystems: SubsystemStatus[];
}

const SUBSYSTEM_TIMEOUT_MS = 2000;

async function checkWithTimeout<T>(
  name: string,
  check: () => Promise<T> | T,
): Promise<SubsystemStatus> {
  const startedAt = Date.now();
  try {
    const result = await Promise.race([
      Promise.resolve(check()),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), SUBSYSTEM_TIMEOUT_MS),
      ),
    ]);
    return {
      name,
      status: 'healthy',
      latencyMs: Date.now() - startedAt,
      message: result === undefined ? 'ok' : String(result),
    };
  } catch (error) {
    return {
      name,
      status: 'unhealthy',
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkDatabase(): Promise<SubsystemStatus> {
  return checkWithTimeout('database', async () => {
    await dbHelper.all(sql`SELECT 1`);
    return 'connected';
  });
}

async function checkLLMClients(): Promise<SubsystemStatus> {
  return checkWithTimeout('llm_clients', () => {
    const hasOpenAI = llmClientManager.hasClient('openai');
    const hasOpenRouter = llmClientManager.hasClient('openrouter');
    if (!hasOpenAI && !hasOpenRouter) {
      throw new Error('No LLM client configured');
    }
    return hasOpenAI && hasOpenRouter ? 'openai+openrouter' : hasOpenAI ? 'openai' : 'openrouter';
  });
}

async function checkEmbeddingProvider(): Promise<SubsystemStatus> {
  return checkWithTimeout('embeddings', () => {
    // EMB-001: surface degradation honestly. 'degraded' covers both
    // persistent (configured local) and transient (remote failed → local
    // fallback) states, so callers can distinguish a healthy remote
    // provider from a lexical-only one.
    if (embeddingsManager.isDegraded()) {
      return embeddingsManager.isUsingLocalEmbeddings() ? 'degraded:local' : 'degraded:fallback';
    }
    return 'remote';
  });
}

async function checkResponseCache(): Promise<SubsystemStatus> {
  return checkWithTimeout('response_cache', () => {
    const stats = aiResponseCache.getStats();
    return `size=${stats.size}`;
  });
}

async function checkSemanticCache(): Promise<SubsystemStatus> {
  const checked = await checkWithTimeout('semantic_cache', () => {
    const stats = semanticCacheService.getStats();
    return `size=${stats.size};backingStore=${stats.backingStore}`;
  });
  if (
    checked.status === 'healthy' &&
    process.env.REDIS_URL &&
    semanticCacheService.getStats().backingStore === 'memory'
  ) {
    return {
      ...checked,
      status: 'degraded',
      message: `${checked.message};redis=requested_but_unavailable`,
    };
  }
  return checked;
}

function checkAuditTrail(): SubsystemStatus {
  // Spec 015 B3 (M-07/FR-011): perda recente de auditoria degrada o health.
  const lossState = getAuditLossState();
  if (lossState.degraded) {
    return {
      name: 'audit_trail',
      status: 'degraded',
      message: `losses=${lossState.totalLosses};lastSink=${lossState.lastSink}`,
    };
  }
  return { name: 'audit_trail', status: 'healthy', message: `losses=${lossState.totalLosses}` };
}

function checkGuardrails(): SubsystemStatus {
  // Spec 012 (H-07/FR-010): degradação de guardrail é visível no health.
  const state = getGuardrailHealthState();
  if (state.degraded) {
    return {
      name: 'guardrails',
      status: 'degraded',
      message: `reason=${state.lastReason};since=${state.since ? new Date(state.since).toISOString() : 'unknown'}`,
    };
  }
  return { name: 'guardrails', status: 'healthy', message: 'enforcement=active' };
}

/**
 * Auditoria 2026-08-01 (A07): o resultado do `verifyDeployedSchema` era apenas
 * logado no boot — o readiness nunca o consultava, então um servidor com
 * schema divergente (ou com o schema sequer inspecionável) respondia `ready`.
 *
 * `unknown` conta como não-saudável de propósito: não conseguir olhar o schema
 * não é o mesmo que olhar e estar são, e era exatamente essa confusão que fazia
 * a falha de inspeção virar `[]` e passar por saúde.
 */
function checkSchema(): SubsystemStatus {
  const result = getLastSchemaHealth();

  if (result.status === 'healthy') {
    return { name: 'schema', status: 'healthy', message: 'sem drift no banco implantado' };
  }

  if (result.status === 'drift') {
    const amostra = result.drift
      .slice(0, 3)
      .map((d) => `${d.table}.${d.column}`)
      .join(', ');
    return {
      name: 'schema',
      status: 'unhealthy',
      message: `drift em ${result.drift.length} coluna(s): ${amostra}${result.drift.length > 3 ? '…' : ''}`,
    };
  }

  return {
    name: 'schema',
    status: 'unhealthy',
    message: `schema não pôde ser verificado${result.error ? `: ${result.error}` : ''}`,
  };
}

export async function getHealthStatus(): Promise<HealthCheckResult> {
  const subsystems = await Promise.all([
    checkDatabase(),
    checkLLMClients(),
    checkEmbeddingProvider(),
    checkResponseCache(),
    checkSemanticCache(),
    Promise.resolve(checkGuardrails()),
    Promise.resolve(checkAuditTrail()),
    Promise.resolve(checkSchema()),
  ]);

  const unhealthyCount = subsystems.filter((s) => s.status === 'unhealthy').length;
  const degradedCount = subsystems.filter((s) => s.status === 'degraded').length;

  let status: HealthCheckResult['status'] = 'healthy';
  if (unhealthyCount > 0) status = 'unhealthy';
  else if (degradedCount > 0) status = 'degraded';

  return {
    status,
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    subsystems,
  };
}

export async function getReadyStatus(): Promise<HealthCheckResult> {
  const health = await getHealthStatus();

  // Ready only when all critical subsystems are healthy
  // A07: 'schema' entra como crítico — servir com schema divergente é pior que
  // não servir, porque a falha aparece depois, como dado errado.
  const critical = ['database', 'llm_clients', 'schema'];
  const criticalStatuses = health.subsystems.filter((s) => critical.includes(s.name));
  const allCriticalHealthy = criticalStatuses.every((s) => s.status === 'healthy');

  if (!allCriticalHealthy) {
    return {
      ...health,
      status: 'unhealthy',
    };
  }

  return {
    ...health,
    status: 'healthy',
  };
}

export function logHealthStatus(result: HealthCheckResult): void {
  const summary = result.subsystems
    .map((s) => `${s.name}:${s.status}${s.latencyMs ? `(${s.latencyMs}ms)` : ''}`)
    .join(' | ');

  if (result.status === 'healthy') {
    logger.info(`[HealthCheck] ${summary}`);
  } else {
    logger.warn(`[HealthCheck] status=${result.status} | ${summary}`);
  }
}
