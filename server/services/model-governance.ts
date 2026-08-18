import { logger } from '../utils/logger';
import { normalizeForGovernance, isModelRegistryEnabled } from './model-registry-bridge';

export const CONTRACT_VERSION = '1.1.0';

export const ALLOWED_MODELS = [
  // Primary models
  'qwen/qwen3-coder-next', // Code tasks (via OpenRouter)
  'qwen/qwen3-coder', // Qwen3-Coder-480B-A35B-Instruct (via OpenRouter)
  // 2026-07-20: 'xiaomi/mimo-v2.5-pro' (MiMo via OpenRouter) REMOVIDO — decisão
  // do usuário: MiMo roda SEMPRE pela chave nativa Xiaomi (ids sem prefixo).
  // Governança agora bloqueia qualquer chamada MiMo roteada pelo OpenRouter.
  'mimo-v2.5-pro', // PM/PO pro-tier (via native Xiaomi key)
  'mimo-v2.5', // MiMo-V2.5 multimodal (via native Xiaomi key)
  'deepseek/deepseek-v4-pro', // General agents (via Tencent TokenHub)
  'deepseek/deepseek-v4-flash', // Fast/economic model (via Tencent TokenHub)
  // Tencent TokenHub concrete model IDs (resolved by llm-model-router)
  'deepseek-v4-pro-202606',
  'deepseek-v4-flash-202605',
  'z-ai/glm-5.2', // GLM-5.2 fallback (via OpenRouter)
  'glm-5.2', // GLM-5.2 flagship reasoning (via Tencent TokenHub) — UX Designer, Scrum Master, Anti-Overengineering
  // 2026-08-07: 'z-ai/glm-4.7-flash' REMOVIDO do hot path — decisão do usuário:
  // trocar pelo modelo GLM mais avançado (GLM-5.2), já nativo Tencent TokenHub.
  // Mantido na allowlist só para telemetria/compat retroativa de logs antigos.
  'z-ai/glm-4.7-flash',
  'minimax-m3', // Analista de Dados (via Tencent TokenHub — id nativo, sem prefixo)
  'minimax/minimax-m3', // Espelho OpenRouter do MiniMax-M3 (compat retroativa)
  'minimax/minimax-m2.7', // MiniMax-M2.7 (via OpenRouter)
  'minimax/minimax-m2.5', // Analista de Dados (via OpenRouter, 2026-07-20)
  'moonshotai/kimi-k2.5', // Kimi K2.5 deprecated (via OpenRouter)
  'moonshotai/kimi-k2.6', // Kimi K2.6 fallback (via OpenRouter)
  'kimi-k2.6', // Kimi K2.6 latest (via Tencent TokenHub)

  // Fallback models (Mistral)
  'mistral-medium-3.5', // Mistral Medium 3.5 (frontier-class fallback)
  'mistral-small-2603', // Mistral Small 4 (economic fallback)
  'codestral-latest',

  // Model Registry aliases (resolved to concrete ids above before validation
  // when the registry is enabled). Listed here so that agent YAML files can
  // reference stable aliases like `mimo-pro-latest` even when the registry is
  // disabled — governance accepts the alias directly in that case.
  'mimo-pro-latest',
  'mimo-flash-latest',
  'deepseek-v4-pro-latest',
  'deepseek-v4-flash-latest',
  'glm-latest',
  'glm-flash-latest',
  'qwen-coder-latest',
  'minimax-m-latest',
  'codestral-latest',
  'kimi-latest',
  'mistral-medium-latest',
] as const;

const normalizeModelId = (model: string): string => model.trim().toLowerCase();
const ALLOWED_MODEL_SET = new Set<string>(ALLOWED_MODELS.map(normalizeModelId));

export class ModelGovernanceError extends Error {
  public code: string;
  public details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ModelGovernanceError';
    this.code = code;
    this.details = details;
  }
}

/**
 * True when `alias` is itself a governed alias (listed in ALLOWED_MODELS).
 * Used to accept a concrete model id that the Model Registry resolved for
 * that alias even when the id itself isn't statically listed — the id was
 * already vetted by the promotion pipeline (candidate binding + smoke test)
 * before being written as the alias's active model.
 */
export function isAliasGoverned(alias: string): boolean {
  return ALLOWED_MODEL_SET.has(normalizeModelId(alias));
}

export function validateModelAllowed(
  model: string,
  agent: string,
  context: string,
  registryAlias?: string,
): void {
  const effectiveModel = normalizeModelId(model);

  if (ALLOWED_MODEL_SET.has(effectiveModel)) return;

  // Model Registry escape hatch: the concrete id came from resolving a
  // governed alias (i.e. it is the alias's current activeModelId, set only
  // through the promotion pipeline), so it inherits the alias's governance.
  if (registryAlias && isAliasGoverned(registryAlias)) {
    logger.info(`[MODEL_GUARD] Model allowed via governed registry alias: ${registryAlias}`, {
      context: { agent, routeContext: context, effectiveModel, registryAlias },
    });
    return;
  }

  logger.error(`[MODEL_GUARD] Model not allowed: ${model}`, {
    context: {
      agent,
      routeContext: context,
      effectiveModel,
      contract_version: CONTRACT_VERSION,
      error_code: 'MODEL_NOT_ALLOWED',
    },
  });

  throw new ModelGovernanceError('MODEL_NOT_ALLOWED', `Modelo efetivo não permitido: ${model}`, {
    agent,
    routeContext: context,
    modelEfetivo: model,
    contract_version: CONTRACT_VERSION,
    output_contract_valid: false,
    error_code: 'MODEL_NOT_ALLOWED',
  });
}

/**
 * Async variant of validateModelAllowed. When the model registry is enabled,
 * resolves aliases to their concrete model ids before validation. This
 * allows agent YAML files to reference stable aliases like `mimo-pro-latest`
 * that resolve to the currently-active concrete model id.
 *
 * When the registry is disabled, behaves identically to validateModelAllowed.
 */
export async function validateModelAllowedAsync(
  model: string,
  agent: string,
  context: string,
): Promise<void> {
  const effectiveModel = isModelRegistryEnabled()
    ? normalizeModelId(await normalizeForGovernance(model))
    : normalizeModelId(model);

  if (!ALLOWED_MODEL_SET.has(effectiveModel)) {
    logger.error(`[MODEL_GUARD] Model not allowed: ${model}`, {
      context: {
        agent,
        routeContext: context,
        effectiveModel,
        contract_version: CONTRACT_VERSION,
        registryEnabled: isModelRegistryEnabled(),
        error_code: 'MODEL_NOT_ALLOWED',
      },
    });

    throw new ModelGovernanceError('MODEL_NOT_ALLOWED', `Modelo efetivo não permitido: ${model}`, {
      agent,
      routeContext: context,
      modelEfetivo: model,
      contract_version: CONTRACT_VERSION,
      output_contract_valid: false,
      error_code: 'MODEL_NOT_ALLOWED',
    });
  }
}

export function validateContract(
  isValid: boolean,
  agent: string,
  context: string,
  model: string,
  failureReason: string,
): void {
  if (!isValid) {
    logger.error(`[CONTRACT_VIOLATION] Output contract failed for ${agent}`, {
      context: {
        agent,
        routeContext: context,
        modelEfetivo: model,
        contract_version: CONTRACT_VERSION,
        reason: failureReason,
        error_code: 'OUTPUT_CONTRACT_VIOLATION',
      },
    });

    throw new ModelGovernanceError(
      'OUTPUT_CONTRACT_VIOLATION',
      `Falha no contrato mínimo versão ${CONTRACT_VERSION}: ${failureReason}`,
      {
        agent,
        routeContext: context,
        modelEfetivo: model,
        contract_version: CONTRACT_VERSION,
        output_contract_valid: false,
        error_code: 'OUTPUT_CONTRACT_VIOLATION',
      },
    );
  }
}
