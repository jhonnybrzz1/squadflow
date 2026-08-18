import path from 'node:path';
import { projectRoot } from '@shared/utils/paths';

/**
 * Spec 10125 #13: centralização tipada das variáveis de ambiente.
 *
 * Todas as variáveis de ambiente acessadas pelo servidor devem ser exportadas
 * daqui. Isso evita `process.env` espalhado, typos e defaults inconsistentes.
 */

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Variável de ambiente obrigatória não definida: ${key}`);
  }
  return value;
}

function getEnvAsNumber(key: string, defaultValue?: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Variável de ambiente obrigatória não definida: ${key}`);
  }
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Variável de ambiente ${key} deve ser um número válido, recebeu: ${raw}`);
  }
  return parsed;
}

export const env = {
  // Few-shot datasets
  fewshotDatasetDir: getEnv('FEWSHOT_DATASET_DIR', path.join(projectRoot, 'datasets', 'few-shot')),
  fewshotAgentsDir: getEnv('FEWSHOT_AGENTS_DIR', path.join(projectRoot, 'agents')),

  // Cache
  aiCacheThreshold: getEnvAsNumber('AI_CACHE_THRESHOLD', 0.85),
  aiResponseCacheMaxEntries: getEnvAsNumber('AI_RESPONSE_CACHE_MAX_ENTRIES', 250),
  aiResponseCacheTtlMs: getEnvAsNumber('AI_RESPONSE_CACHE_TTL_MS', 30 * 60 * 1000),
  semanticCacheEnabled: process.env.SEMANTIC_CACHE_ENABLED !== 'false',
  semanticCacheMaxEntries: getEnvAsNumber('SEMANTIC_CACHE_MAX_ENTRIES', 250),
  semanticCacheTtlMs: getEnvAsNumber('SEMANTIC_CACHE_TTL_MS', 30 * 60 * 1000),

  // LLM / API
  openaiApiKey: getEnv('OPENAI_API_KEY', ''),
  openrouterApiKey: getEnv('OPENROUTER_API_KEY', ''),
  adminApiKey: getEnv('ADMIN_API_KEY', ''),

  // Runtime
  nodeEnv: getEnv('NODE_ENV', 'development'),
  isDebugEnv: ['development', 'staging', 'test'].includes(getEnv('NODE_ENV', 'development')),

  // Groundedness (A-2)
  groundednessBigramLowThreshold: getEnvAsNumber('GROUNDEDNESS_BIGRAM_LOW_THRESHOLD', 0.2),
  groundednessBigramHighThreshold: getEnvAsNumber('GROUNDEDNESS_BIGRAM_HIGH_THRESHOLD', 0.5),
  groundednessDegradeThreshold: getEnvAsNumber('GROUNDEDNESS_DEGRADE_THRESHOLD', 10),

  // Retry / Backoff
  retryMaxAttempts: getEnvAsNumber('RETRY_MAX_ATTEMPTS', 3),
  retryInitialDelayMs: getEnvAsNumber('RETRY_INITIAL_DELAY_MS', 350),
  retryBackoffMultiplier: getEnvAsNumber('RETRY_BACKOFF_MULTIPLIER', 2),
  retryMaxDelayMs: getEnvAsNumber('RETRY_MAX_DELAY_MS', 10_000),

  // A-2: backoff configurável por worker
  orchestrationMaxRetries: getEnvAsNumber('ORCHESTRATION_MAX_RETRIES', 5),
  orchestrationBaseBackoffMs: getEnvAsNumber('ORCHESTRATION_BASE_BACKOFF_MS', 50),
  orchestrationMaxBackoffMs: getEnvAsNumber('ORCHESTRATION_MAX_BACKOFF_MS', 5_000),
  workerBackoffDocumentMs: getEnvAsNumber('WORKER_BACKOFF_DOCUMENT', 200),
  workerBackoffDemandGenMs: getEnvAsNumber('WORKER_BACKOFF_DEMAND_GEN', 200),
  workerMaxRetries: getEnvAsNumber('WORKER_MAX_RETRIES', 5),
  workerMaxBackoffMs: getEnvAsNumber('WORKER_MAX_BACKOFF_MS', 5_000),

  // A-1: retry do AgentOrchestrator
  orchestratorAgentMaxRetries: getEnvAsNumber('ORCHESTRATOR_AGENT_MAX_RETRIES', 3),
} as const;
