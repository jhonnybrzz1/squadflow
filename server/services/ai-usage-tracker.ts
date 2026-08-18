import { logger } from '../utils/logger';

export interface ModelPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
}

export type PricingSource = 'dynamic' | 'static' | 'override' | 'unknown';

export interface CostEstimate {
  listCostUsd: number | null;
  billedCostUsd: null;
  creditAppliedUsd: null;
  pricingSource: PricingSource;
  pricingUpdatedAt: string | null;
  isEstimated: true;
}

export type RoutingMode = 'economic' | 'safe' | 'unknown';

export interface AIUsageRecord {
  timestamp: string;
  demandId?: number; // Added for progressive refinement tracking
  operation: string;
  model: string;
  /** Logical registry alias retained alongside the concrete provider model. */
  modelAlias?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  pricingSource?: PricingSource;
  pricingUpdatedAt?: string | null;
  billedCostUsd?: number | null;
  creditAppliedUsd?: number | null;
  isEstimated?: boolean;
  cacheHit: boolean;
  estimatedTokensSaved: number;
  estimatedCostSavedUsd: number | null;
  latencyMs: number;
  // Cost optimization telemetry fields
  requestId?: string;
  routingMode?: RoutingMode;
  routingReason?: string | null;
  cacheKeyVersion?: string | null;
  fallbackUsed?: boolean;
  /** Demanda 10100: true quando a chamada foi feita por um subagente. */
  delegation?: boolean;
  /** Demanda 10100: profundidade da delegação (1 para subagentes). */
  depth?: number;
  /** M-2: identificador do agente, sempre prefixado com 'agent:'. */
  agentId?: string;
  /** M-2: etapa do pipeline (ex.: 'enrichment', 'priming'). */
  stage?: string;
}

export interface AgentUsageSummary {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  unpricedTokens: number;
}

export interface StageUsageSummary {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  unpricedTokens: number;
}

export interface AIUsageSummary {
  requestCount: number;
  cacheHits: number;
  cacheMisses: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  unpricedTokens: number;
  estimatedTokensSaved: number;
  estimatedCostSavedUsd: number;
  byModel: Record<
    string,
    {
      requestCount: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      estimatedCostUsd: number;
      unpricedTokens: number;
    }
  >;
  /** M-2: agregação por agente (agentId normalizado). */
  byAgent: Record<string, AgentUsageSummary>;
  /** M-2: agregação por etapa (stage normalizado). */
  byStage: Record<string, StageUsageSummary>;
  recent: AIUsageRecord[];
  // Cost optimization telemetry summary
  routing: {
    economicCount: number;
    safeCount: number;
    unknownCount: number;
    fallbackCount: number;
    fallbackRate: number;
  };
}

const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenRouter free variants
  'inclusionai/ring-2.6-1t:free': { inputUsdPer1M: 0, outputUsdPer1M: 0 },
  'openrouter/free': { inputUsdPer1M: 0, outputUsdPer1M: 0 },
  'inclusionai/ling-2.6-flash': { inputUsdPer1M: 0.08, outputUsdPer1M: 0.24 },
  'inclusionai/ling-2.6-1t': { inputUsdPer1M: 0.3, outputUsdPer1M: 2.5 },
  'openai/gpt-oss-120b:free': { inputUsdPer1M: 0, outputUsdPer1M: 0 },
  'openai/gpt-oss-20b:free': { inputUsdPer1M: 0, outputUsdPer1M: 0 },
  'openrouter:inclusionai/ring-2.6-1t:free': { inputUsdPer1M: 0, outputUsdPer1M: 0 },
  'openrouter:openrouter/free': { inputUsdPer1M: 0, outputUsdPer1M: 0 },
  'openrouter:inclusionai/ling-2.6-flash': { inputUsdPer1M: 0.08, outputUsdPer1M: 0.24 },
  'openrouter:inclusionai/ling-2.6-1t': { inputUsdPer1M: 0.3, outputUsdPer1M: 2.5 },
  'openrouter:openai/gpt-oss-120b:free': { inputUsdPer1M: 0, outputUsdPer1M: 0 },
  'openrouter:openai/gpt-oss-20b:free': { inputUsdPer1M: 0, outputUsdPer1M: 0 },
  'local:feature-hash-3072': { inputUsdPer1M: 0, outputUsdPer1M: 0 },
  // Rule-based (zero cost)
  'rule-based': { inputUsdPer1M: 0, outputUsdPer1M: 0 },
  // OpenAI embedding models
  'text-embedding-3-small': { inputUsdPer1M: 0.02, outputUsdPer1M: 0 },
  'text-embedding-3-large': { inputUsdPer1M: 0.13, outputUsdPer1M: 0 },
  'openai:text-embedding-3-small': { inputUsdPer1M: 0.02, outputUsdPer1M: 0 },
  'openai:text-embedding-3-large': { inputUsdPer1M: 0.13, outputUsdPer1M: 0 },
  // Qwen embedding (via OpenRouter)
  'qwen/qwen3-embedding-8b': { inputUsdPer1M: 0.01, outputUsdPer1M: 0 },
  'openrouter:qwen/qwen3-embedding-8b': { inputUsdPer1M: 0.01, outputUsdPer1M: 0 },
  // OpenAI models (preços corrigidos - maio 2026)
  'gpt-4o-mini': { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  'gpt-4o': { inputUsdPer1M: 2.5, outputUsdPer1M: 10 },
  'gpt-4.1-mini': { inputUsdPer1M: 0.4, outputUsdPer1M: 1.6 },
  'gpt-4.1': { inputUsdPer1M: 2, outputUsdPer1M: 8 },
  'gpt-5.4-nano': { inputUsdPer1M: 0.2, outputUsdPer1M: 1.25 },
  'gpt-5.4-mini': { inputUsdPer1M: 0.75, outputUsdPer1M: 4.5 },
  'openai:gpt-5.4-nano': { inputUsdPer1M: 0.2, outputUsdPer1M: 1.25 },
  'openai:gpt-5.4-mini': { inputUsdPer1M: 0.75, outputUsdPer1M: 4.5 },
  // Mistral list prices. Account credits/free-tier entitlements are tracked separately.
  // Canonical Mistral models (current).
  'mistral-medium-3.5': { inputUsdPer1M: 1.5, outputUsdPer1M: 7.5 },
  'mistral-small-2603': { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  'mistral:mistral-medium-3.5': { inputUsdPer1M: 1.5, outputUsdPer1M: 7.5 },
  'mistral:mistral-small-2603': { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  // Legacy Mistral aliases (normalize to current pricing for backward-compat telemetry).
  'mistral-medium-latest': { inputUsdPer1M: 1.5, outputUsdPer1M: 7.5 },
  'mistral-medium-2604': { inputUsdPer1M: 1.5, outputUsdPer1M: 7.5 },
  'mistral-large-latest': { inputUsdPer1M: 1.5, outputUsdPer1M: 7.5 },
  'mistral-large-3': { inputUsdPer1M: 1.5, outputUsdPer1M: 7.5 },
  'mistral-small-3': { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  'mistral:mistral-medium-latest': { inputUsdPer1M: 1.5, outputUsdPer1M: 7.5 },
  'mistral:mistral-large-latest': { inputUsdPer1M: 1.5, outputUsdPer1M: 7.5 },
  'mistral:mistral-large-3': { inputUsdPer1M: 1.5, outputUsdPer1M: 7.5 },
  // Codestral
  'codestral-25.08': { inputUsdPer1M: 0.2, outputUsdPer1M: 0.6 },
  'codestral-latest': { inputUsdPer1M: 0.2, outputUsdPer1M: 0.6 },
  'mistral:codestral-25.08': { inputUsdPer1M: 0.2, outputUsdPer1M: 0.6 },
  // DeepSeek models (primary for general agents)
  // 2026-08-07: preço corrigido a partir da tabela oficial do TokenHub — o
  // valor anterior (0.14/0.28) era o do Flash, não o do Pro (achado da
  // análise de viabilidade de migração TokenHub).
  'deepseek/deepseek-v4-pro': { inputUsdPer1M: 0.435, outputUsdPer1M: 0.87 },
  'openrouter:deepseek/deepseek-v4-pro': { inputUsdPer1M: 0.14, outputUsdPer1M: 0.28 },
  // Tencent TokenHub concrete ids (原厂直供 / vendor-direct pricing)
  'deepseek-v4-pro-202606': { inputUsdPer1M: 0.435, outputUsdPer1M: 0.87 },
  'tencent:deepseek-v4-pro-202606': { inputUsdPer1M: 0.435, outputUsdPer1M: 0.87 },
  'deepseek-v4-flash-202605': { inputUsdPer1M: 0.14, outputUsdPer1M: 0.28 },
  'tencent:deepseek-v4-flash-202605': { inputUsdPer1M: 0.14, outputUsdPer1M: 0.28 },
  'deepseek/deepseek-v4-flash': { inputUsdPer1M: 0.14, outputUsdPer1M: 0.28 },
  'tencent:deepseek/deepseek-v4-flash': { inputUsdPer1M: 0.14, outputUsdPer1M: 0.28 },

  // Qwen models (code tasks)
  'qwen/qwen3-coder-next': { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  'openrouter:qwen/qwen3-coder-next': { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  // Qwen3-Coder-480B-A35B-Instruct (via OpenRouter)
  'qwen/qwen3-coder': { inputUsdPer1M: 0.22, outputUsdPer1M: 1.8 },
  'openrouter:qwen/qwen3-coder': { inputUsdPer1M: 0.22, outputUsdPer1M: 1.8 },
  // Xiaomi MiMo (data analyst & TDD, via OpenRouter)
  'xiaomi/mimo-v2.5-pro': { inputUsdPer1M: 0.2, outputUsdPer1M: 0.8 },
  'openrouter:xiaomi/mimo-v2.5-pro': { inputUsdPer1M: 0.2, outputUsdPer1M: 0.8 },
  // Xiaomi MiMo pro-tier (PM/PO/Tech Lead, via native Xiaomi key). Placeholder
  // list price — align with the Xiaomi token-plan pricing.
  'mimo-v2.5-pro': { inputUsdPer1M: 0.2, outputUsdPer1M: 0.8 },
  'xiaomi:mimo-v2.5-pro': { inputUsdPer1M: 0.2, outputUsdPer1M: 0.8 },
  // Xiaomi MiMo-V2.5 (multimodal, via native Xiaomi key)
  'mimo-v2.5': { inputUsdPer1M: 0.14, outputUsdPer1M: 0.28 },
  'xiaomi:mimo-v2.5': { inputUsdPer1M: 0.14, outputUsdPer1M: 0.28 },
  'openrouter:xiaomi/mimo-v2.5': { inputUsdPer1M: 0.14, outputUsdPer1M: 0.28 },
  // GLM-5.2 flagship reasoning (Tencent TokenHub primary, OpenRouter fallback)
  'glm-5.2': { inputUsdPer1M: 1.4, outputUsdPer1M: 4.4 },
  'tencent:glm-5.2': { inputUsdPer1M: 1.4, outputUsdPer1M: 4.4 },
  'z-ai/glm-5.2': { inputUsdPer1M: 1.4, outputUsdPer1M: 4.4 },
  'openrouter:z-ai/glm-5.2': { inputUsdPer1M: 1.4, outputUsdPer1M: 4.4 },
  // Kimi K2.6 (Tencent TokenHub primary, OpenRouter fallback)
  // 2026-08-07: preço corrigido a partir da tabela oficial do TokenHub
  // (achado da análise de viabilidade de migração TokenHub).
  'kimi-k2.6': { inputUsdPer1M: 0.858, outputUsdPer1M: 3.566 },
  'tencent:kimi-k2.6': { inputUsdPer1M: 0.858, outputUsdPer1M: 3.566 },
  'moonshotai/kimi-k2.6': { inputUsdPer1M: 0.66, outputUsdPer1M: 3.41 },
  'openrouter:moonshotai/kimi-k2.6': { inputUsdPer1M: 0.66, outputUsdPer1M: 3.41 },
  // Kimi K2.5 deprecated (OpenRouter)
  'moonshotai/kimi-k2.5': { inputUsdPer1M: 0.66, outputUsdPer1M: 3.41 },
  'openrouter:moonshotai/kimi-k2.5': { inputUsdPer1M: 0.66, outputUsdPer1M: 3.41 },
  // 2026-08-07: GLM-4.7-Flash REMOVIDO do hot path (Scrum Master, UX Designer,
  // Anti-Overengineering agora usam GLM-5.2 via Tencent TokenHub — decisão do
  // usuário, preço similar ao de outros modelos já homologados no TokenHub).
  // Entrada mantida só para telemetria retroativa de execuções antigas.
  'z-ai/glm-4.7-flash': { inputUsdPer1M: 0.06, outputUsdPer1M: 0.4 },
  'openrouter:z-ai/glm-4.7-flash': { inputUsdPer1M: 0.06, outputUsdPer1M: 0.4 },
  // MiniMax-M3 (Analista de Dados, via Tencent TokenHub — id nativo, 2026-08-07)
  'minimax-m3': { inputUsdPer1M: 0.3, outputUsdPer1M: 1.2 },
  'tencent:minimax-m3': { inputUsdPer1M: 0.3, outputUsdPer1M: 1.2 },
  'minimax/minimax-m3': { inputUsdPer1M: 0.3, outputUsdPer1M: 1.2 },
  'openrouter:minimax/minimax-m3': { inputUsdPer1M: 0.3, outputUsdPer1M: 1.2 },
  // MiniMax-M2.7 (via OpenRouter)
  'minimax/minimax-m2.7': { inputUsdPer1M: 0.3, outputUsdPer1M: 1.2 },
  'openrouter:minimax/minimax-m2.7': { inputUsdPer1M: 0.3, outputUsdPer1M: 1.2 },
  // MiniMax M2.5 (deprecated 2026-08-07 no TokenHub) — preço corrigido a
  // partir da tabela oficial do TokenHub.
  'minimax/minimax-m2.5': { inputUsdPer1M: 0.3, outputUsdPer1M: 1.2 },
  'openrouter:minimax/minimax-m2.5': { inputUsdPer1M: 0.15, outputUsdPer1M: 0.9 },
  // Google Gemma (legacy PM model)
  'google/gemma-4-31b-it': { inputUsdPer1M: 0.1, outputUsdPer1M: 0.3 },
  'openrouter:google/gemma-4-31b-it': { inputUsdPer1M: 0.1, outputUsdPer1M: 0.3 },
};

const parsePositiveNumber = (value: string | undefined): number | null => {
  const parsed = Number.parseFloat(value || '');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function estimateTextTokens(text: string): number {
  if (!text) {
    return 0;
  }

  return Math.max(1, Math.ceil(text.length / 4));
}

export function getModelPricing(model: string): ModelPricing | null {
  const normalizedModel = model.trim().toLowerCase();
  const envInput = parsePositiveNumber(process.env.OPENAI_INPUT_COST_USD_PER_1M);
  const envOutput = parsePositiveNumber(process.env.OPENAI_OUTPUT_COST_USD_PER_1M);
  const isOpenAIModel = normalizedModel.startsWith('gpt-') || normalizedModel.startsWith('openai:');

  if (isOpenAIModel && envInput !== null && envOutput !== null) {
    return {
      inputUsdPer1M: envInput,
      outputUsdPer1M: envOutput,
    };
  }

  return DEFAULT_MODEL_PRICING[normalizedModel] || null;
}

function calculateCost(
  pricing: ModelPricing,
  promptTokens: number,
  completionTokens: number,
): number | null {
  if (
    !Number.isFinite(promptTokens) ||
    !Number.isFinite(completionTokens) ||
    promptTokens < 0 ||
    completionTokens < 0
  ) {
    return null;
  }
  const inputCost = (promptTokens / 1_000_000) * pricing.inputUsdPer1M;
  const outputCost = (completionTokens / 1_000_000) * pricing.outputUsdPer1M;
  return Number((inputCost + outputCost).toFixed(8));
}

export async function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): Promise<CostEstimate> {
  // Resolve model registry aliases to concrete model ids before pricing lookup.
  // When the registry is disabled or the input is not a known alias, this
  // returns the input unchanged (no behavior change).
  const { isModelRegistryEnabled } = await import('./model-registry-bridge');
  let resolvedModel = model;
  if (isModelRegistryEnabled()) {
    const { resolveModelIdSafe } = await import('./model-registry-bridge');
    resolvedModel = await resolveModelIdSafe(model);
  }
  const normalizedModel = resolvedModel.trim().toLowerCase();
  const overrideInput = parsePositiveNumber(process.env.OPENAI_INPUT_COST_USD_PER_1M);
  const overrideOutput = parsePositiveNumber(process.env.OPENAI_OUTPUT_COST_USD_PER_1M);
  const isOpenAIModel = normalizedModel.startsWith('gpt-') || normalizedModel.startsWith('openai:');

  if (isOpenAIModel && overrideInput !== null && overrideOutput !== null) {
    return {
      listCostUsd: calculateCost(
        { inputUsdPer1M: overrideInput, outputUsdPer1M: overrideOutput },
        promptTokens,
        completionTokens,
      ),
      billedCostUsd: null,
      creditAppliedUsd: null,
      pricingSource: 'override',
      pricingUpdatedAt: null,
      isEstimated: true,
    };
  }

  const isOpenRouterModel =
    normalizedModel.includes('/') || normalizedModel.startsWith('openrouter:');

  if (isOpenRouterModel) {
    const { getCachedPricingWithMetadata } = await import('./openrouter-pricing');
    const dynamicQuote = await getCachedPricingWithMetadata(normalizedModel);
    if (dynamicQuote) {
      return {
        listCostUsd: calculateCost(dynamicQuote.pricing, promptTokens, completionTokens),
        billedCostUsd: null,
        creditAppliedUsd: null,
        pricingSource: 'dynamic',
        pricingUpdatedAt: dynamicQuote.pricingUpdatedAt,
        isEstimated: true,
      };
    }
  }

  const staticPricing = getModelPricing(normalizedModel);
  return {
    listCostUsd: staticPricing
      ? calculateCost(staticPricing, promptTokens, completionTokens)
      : null,
    billedCostUsd: null,
    creditAppliedUsd: null,
    pricingSource: staticPricing ? 'static' : 'unknown',
    pricingUpdatedAt: null,
    isEstimated: true,
  };
}

/** @deprecated Use estimateCost() so dynamic pricing metadata is preserved. */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const pricing = getModelPricing(model);
  if (!pricing) {
    return null;
  }

  return calculateCost(pricing, promptTokens, completionTokens);
}

// M-2: regex para validar agentId e stage.
const AGENT_ID_REGEX = /^agent:[a-z0-9._-]+$/;
const STAGE_REGEX = /^[a-z0-9_-]+$/;
const UNLABELED_AGENT = 'agent:unlabeled';
const UNLABELED_STAGE = 'unlabeled';

function isValidAgentId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_ID_REGEX.test(value);
}

function isValidStage(value: unknown): value is string {
  return typeof value === 'string' && STAGE_REGEX.test(value);
}

export function normalizeAgentId(value: unknown): { agentId: string; valid: boolean } {
  if (isValidAgentId(value)) {
    return { agentId: value, valid: true };
  }
  if (value !== undefined && value !== '') {
    logger.warn('M-2: agentId inválido, usando fallback agent:unlabeled', { received: value });
  } else {
    logger.warn('M-2: agentId ausente, usando fallback agent:unlabeled');
  }
  return { agentId: UNLABELED_AGENT, valid: false };
}

export function normalizeStage(value: unknown): { stage: string; valid: boolean } {
  if (isValidStage(value)) {
    return { stage: value, valid: true };
  }
  if (value !== undefined && value !== '') {
    logger.warn('M-2: stage inválido, usando fallback unlabeled', { received: value });
  }
  return { stage: UNLABELED_STAGE, valid: false };
}

export class AIUsageTracker {
  private readonly records: AIUsageRecord[] = [];
  private readonly maxRecords = parsePositiveInt(process.env.AI_USAGE_MAX_RECORDS, 1000);

  record(record: AIUsageRecord): void {
    const { agentId } = normalizeAgentId(record.agentId);
    const { stage } = normalizeStage(record.stage);
    this.records.push({ ...record, agentId, stage });

    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
  }

  getSummary(): AIUsageSummary {
    const summary: AIUsageSummary = {
      requestCount: this.records.length,
      cacheHits: 0,
      cacheMisses: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      unpricedTokens: 0,
      estimatedTokensSaved: 0,
      estimatedCostSavedUsd: 0,
      byModel: {},
      byAgent: {},
      byStage: {},
      recent: this.records.slice(-25),
      routing: {
        economicCount: 0,
        safeCount: 0,
        unknownCount: 0,
        fallbackCount: 0,
        fallbackRate: 0,
      },
    };

    for (const record of this.records) {
      if (record.cacheHit) {
        summary.cacheHits += 1;
      } else {
        summary.cacheMisses += 1;
      }

      summary.promptTokens += record.promptTokens;
      summary.completionTokens += record.completionTokens;
      summary.totalTokens += record.totalTokens;
      summary.estimatedTokensSaved += record.estimatedTokensSaved;

      if (record.estimatedCostUsd === null) {
        summary.unpricedTokens += record.totalTokens;
      } else {
        summary.estimatedCostUsd += record.estimatedCostUsd;
      }

      if (record.estimatedCostSavedUsd !== null) {
        summary.estimatedCostSavedUsd += record.estimatedCostSavedUsd;
      }

      // Aggregate routing telemetry
      if (record.routingMode === 'economic') {
        summary.routing.economicCount += 1;
      } else if (record.routingMode === 'safe') {
        summary.routing.safeCount += 1;
      } else {
        summary.routing.unknownCount += 1;
      }

      if (record.fallbackUsed) {
        summary.routing.fallbackCount += 1;
      }

      if (!summary.byModel[record.model]) {
        summary.byModel[record.model] = {
          requestCount: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0,
          unpricedTokens: 0,
        };
      }

      const modelSummary = summary.byModel[record.model];
      modelSummary.requestCount += 1;
      modelSummary.promptTokens += record.promptTokens;
      modelSummary.completionTokens += record.completionTokens;
      modelSummary.totalTokens += record.totalTokens;

      if (record.estimatedCostUsd === null) {
        modelSummary.unpricedTokens += record.totalTokens;
      } else {
        modelSummary.estimatedCostUsd += record.estimatedCostUsd;
      }

      // M-2: aggregate by agent
      const agentId = record.agentId ?? UNLABELED_AGENT;
      if (!summary.byAgent[agentId]) {
        summary.byAgent[agentId] = {
          requestCount: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0,
          unpricedTokens: 0,
        };
      }
      const agentSummary = summary.byAgent[agentId];
      agentSummary.requestCount += 1;
      agentSummary.promptTokens += record.promptTokens;
      agentSummary.completionTokens += record.completionTokens;
      agentSummary.totalTokens += record.totalTokens;
      if (record.estimatedCostUsd === null) {
        agentSummary.unpricedTokens += record.totalTokens;
      } else {
        agentSummary.estimatedCostUsd += record.estimatedCostUsd;
      }

      // M-2: aggregate by stage
      const stage = record.stage ?? UNLABELED_STAGE;
      if (!summary.byStage[stage]) {
        summary.byStage[stage] = {
          requestCount: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0,
          unpricedTokens: 0,
        };
      }
      const stageSummary = summary.byStage[stage];
      stageSummary.requestCount += 1;
      stageSummary.promptTokens += record.promptTokens;
      stageSummary.completionTokens += record.completionTokens;
      stageSummary.totalTokens += record.totalTokens;
      if (record.estimatedCostUsd === null) {
        stageSummary.unpricedTokens += record.totalTokens;
      } else {
        stageSummary.estimatedCostUsd += record.estimatedCostUsd;
      }
    }

    summary.estimatedCostUsd = Number(summary.estimatedCostUsd.toFixed(8));
    summary.estimatedCostSavedUsd = Number(summary.estimatedCostSavedUsd.toFixed(8));

    // Calculate fallback rate
    const totalRoutedRequests = summary.routing.economicCount + summary.routing.safeCount;
    summary.routing.fallbackRate =
      totalRoutedRequests > 0 ? summary.routing.fallbackCount / totalRoutedRequests : 0;

    for (const modelSummary of Object.values(summary.byModel)) {
      modelSummary.estimatedCostUsd = Number(modelSummary.estimatedCostUsd.toFixed(8));
    }

    for (const agentSummary of Object.values(summary.byAgent)) {
      agentSummary.estimatedCostUsd = Number(agentSummary.estimatedCostUsd.toFixed(8));
    }

    for (const stageSummary of Object.values(summary.byStage)) {
      stageSummary.estimatedCostUsd = Number(stageSummary.estimatedCostUsd.toFixed(8));
    }

    return summary;
  }

  reset(): void {
    this.records.splice(0, this.records.length);
  }

  getAllRecords(): AIUsageRecord[] {
    return this.records;
  }

  getUsageForDemand(demandId: number): {
    tokensIn: number;
    tokensOut: number;
    costEstimated: number;
    agentsUsed: string[];
    modelsUsed: Set<string>;
    records: AIUsageRecord[];
  } {
    let tokensIn = 0;
    let tokensOut = 0;
    let costEstimated = 0;
    const agentsUsed = new Set<string>();
    const modelsUsed = new Set<string>();
    const demandRecords: AIUsageRecord[] = [];

    for (const record of this.records) {
      if (record.demandId === demandId) {
        tokensIn += record.promptTokens;
        tokensOut += record.completionTokens;
        costEstimated += record.estimatedCostUsd || 0;
        modelsUsed.add(record.model);
        demandRecords.push(record);

        if (record.operation.startsWith('agent_interaction:')) {
          agentsUsed.add(record.operation.split(':')[1]);
        }
      }
    }

    return {
      tokensIn,
      tokensOut,
      costEstimated,
      agentsUsed: Array.from(agentsUsed),
      modelsUsed,
      records: demandRecords,
    };
  }
}

export const aiUsageTracker = new AIUsageTracker();

// Stub optimizationTracker for routes.ts compatibility
// TODO: Implement full optimization tracking if needed
export const optimizationTracker = {
  getOptimizationReport() {
    const summary = aiUsageTracker.getSummary();
    return {
      totalRequests: summary.requestCount,
      cacheHitRate: summary.requestCount > 0 ? summary.cacheHits / summary.requestCount : 0,
      tokensSaved: summary.estimatedTokensSaved,
      costSaved: summary.estimatedCostSavedUsd,
    };
  },
  getTotalSavings() {
    const summary = aiUsageTracker.getSummary();
    return {
      tokens: summary.estimatedTokensSaved,
      costUsd: summary.estimatedCostSavedUsd,
      bySource: {} as Record<string, number>,
      byStage: {} as Record<string, number>,
    };
  },
};
