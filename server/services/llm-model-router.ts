import type { AIProvider } from './llm-client-manager';

type ModelBehavior = 'fast' | 'standard' | 'reasoning';

interface ModelConfig {
  id: string;
  provider: string;
  behavior: ModelBehavior;
  supportsReasoning: boolean;
  supportsJsonMode?: boolean;
  supportsTools?: boolean;
  defaultTemperature?: number;
}

const modelConfigs: Record<string, Omit<ModelConfig, 'id'>> = {
  'openai/o3': {
    provider: 'openai',
    behavior: 'reasoning',
    supportsReasoning: true,
    defaultTemperature: 0.2,
  },
  'openai/o3-mini': {
    provider: 'openai',
    behavior: 'reasoning',
    supportsReasoning: true,
    defaultTemperature: 0.2,
  },
  'openai/o1': {
    provider: 'openai',
    behavior: 'reasoning',
    supportsReasoning: true,
    defaultTemperature: 0.2,
  },
  'deepseek/deepseek-r1': {
    provider: 'deepseek',
    behavior: 'reasoning',
    supportsReasoning: true,
    defaultTemperature: 0.2,
  },
  'anthropic/claude-thinking': {
    provider: 'anthropic',
    behavior: 'reasoning',
    supportsReasoning: true,
    defaultTemperature: 0.2,
  },
};

interface PromptInput {
  objective: string;
  context: string;
  constraints: string[];
  successCriteria: string[];
  expectedOutput: string;
  originalPrompt?: string;
}

const COT_PATTERNS = [
  /\b(?:pense\s+)?passo\s+a\s+passo\.?\s*/gi,
  /\b(?:think\s+)?step\s+by\s+step\.?\s*/gi,
  /\bexplique\s+seu\s+raciocínio\.?\s*/gi,
  /\bmostre\s+sua\s+cadeia\s+de\s+pensamento\.?\s*/gi,
  /\braciocine\s+profundamente\.?\s*/gi,
  /\banalise\s+cuidadosamente\s+etapa\s+por\s+etapa\.?\s*/gi,
  /\bnão\s+pule\s+etapas\s+mentais\.?\s*/gi,
  /\bfaça\s+uma\s+análise\s+passo\s+a\s+passo\.?\s*/gi,
  /\bchain\s+of\s+thought\.?\s*/gi,
  /\bexplique\s+seu\s+raciocínio\s+interno\.?\s*/gi,
];

export function cleanReasoningPrompt(prompt: string): string {
  if (!prompt) return prompt;
  let cleaned = prompt;

  // Remover seções inteiras de Chain-of-Thought
  cleaned = cleaned.replace(
    /#\s*PROCESSO\s*DE\s*RACIOCÍNIO\s*\(Chain-of-Thought\)[\s\S]*?(?=\n#|\n+---\n+|$|#\s*[A-Z])/gi,
    '',
  );

  // Substituir termos específicos
  for (const pattern of COT_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Limpar quebras de linha excessivas e pontuações duplicadas remanescentes
  cleaned = cleaned
    .replace(/\s+\./g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}

export function buildReasoningPrompt(input: PromptInput): string {
  const constraintsStr = input.constraints.map((c) => `- ${c}`).join('\n');
  const successCriteriaStr = input.successCriteria.map((s) => `- ${s}`).join('\n');

  return `Objetivo:
${input.objective}

Contexto:
${input.context}

Restrições:
${constraintsStr}

Critérios de sucesso:
${successCriteriaStr}

Saída esperada:
${input.expectedOutput}`;
}

export function buildStandardPrompt(input: PromptInput): string {
  if (input.originalPrompt) {
    return input.originalPrompt;
  }

  const constraintsStr = input.constraints.map((c) => `- ${c}`).join('\n');
  const successCriteriaStr = input.successCriteria.map((s) => `- ${s}`).join('\n');

  return `Você é um agente inteligente operando no sistema.
Por favor, resolva a tarefa abaixo.

Objetivo:
${input.objective}

Contexto:
${input.context}

Diretrizes e Restrições:
${constraintsStr}

Como avaliar o sucesso:
${successCriteriaStr}

Formato da resposta:
${input.expectedOutput}

Pense passo a passo para garantir a precisão de cada etapa de raciocínio.`;
}

export function buildPrompt(input: PromptInput, modelConfig: ModelConfig): string {
  if (modelConfig.behavior === 'reasoning') {
    const cleanConstraints = input.constraints.map((c) => cleanReasoningPrompt(c));
    const cleanSuccessCriteria = input.successCriteria.map((s) => cleanReasoningPrompt(s));

    return buildReasoningPrompt({
      objective: cleanReasoningPrompt(input.objective),
      context: cleanReasoningPrompt(input.context),
      constraints: cleanConstraints,
      successCriteria: cleanSuccessCriteria,
      expectedOutput: cleanReasoningPrompt(input.expectedOutput),
    });
  }

  return buildStandardPrompt(input);
}

export function getModelConfig(modelId: string): ModelConfig {
  const normalized = modelId.toLowerCase();

  const configKey = Object.keys(modelConfigs).find(
    (key) =>
      normalized === key.toLowerCase() ||
      normalized.endsWith('/' + key.toLowerCase()) ||
      normalized === key.toLowerCase().split('/')[1],
  );

  if (configKey) {
    return {
      id: modelId,
      ...modelConfigs[configKey],
    };
  }

  const isReasoning =
    normalized.includes('o1-') ||
    normalized.includes('o3-') ||
    normalized.includes('/o1') ||
    normalized.includes('/o3') ||
    normalized.includes('-o1') ||
    normalized.includes('-o3') ||
    normalized === 'o1' ||
    normalized === 'o3' ||
    normalized.includes('deepseek-r1') ||
    normalized.includes('claude-thinking') ||
    normalized.includes('thinking') ||
    normalized.includes('-r1') ||
    normalized.includes('reasoning');

  return {
    id: modelId,
    provider: resolveProvider(modelId),
    behavior: isReasoning ? 'reasoning' : 'standard',
    supportsReasoning: isReasoning,
    defaultTemperature: isReasoning ? 0.2 : 0.7,
  };
}

export function buildDemandRefinementPrompt(
  demand: { title: string; description: string; type: string; priority: string },
  contextData: string,
  modelConfig: ModelConfig,
): string {
  const input: PromptInput = {
    objective: 'Avaliar se a demanda está pronta para seguir para desenvolvimento.',
    context: `A demanda será usada por PM, PO, UX e engenharia para decidir escopo, prioridade e viabilidade.\n\nDemanda:\nTítulo: ${demand.title}\nDescrição: ${demand.description}\nTipo: ${demand.type}\nPrioridade: ${demand.priority}\n\nContexto adicional:\n${contextData}`,
    constraints: [
      'Não invente informações ausentes.',
      'Sinalize hipóteses explicitamente.',
      'Destaque ambiguidades críticas.',
      'Não exponha cadeia de pensamento.',
      'Forneça apenas justificativas curtas e verificáveis.',
    ],
    successCriteria: [
      'A análise deve permitir decidir se a demanda pode seguir, deve voltar para refinamento ou precisa ser quebrada em partes menores.',
    ],
    expectedOutput: `1. Diagnóstico geral
2. Problema identificado
3. Usuário impactado
4. Lacunas críticas
5. Perguntas obrigatórias
6. Critérios de aceite sugeridos
7. Riscos e dependências
8. Recomendação final:
- Aprovar
- Devolver para refinamento
- Quebrar em demandas menores
- Enviar para análise técnica`,
  };

  return buildPrompt(input, modelConfig);
}

export function buildEvaluationPrompt(
  demand: { title: string; description: string; type: string; priority: string },
  refinementContent: string,
  modelConfig: ModelConfig,
): string {
  const input: PromptInput = {
    objective:
      'Julgar se o refinamento da demanda atende aos critérios objetivos de qualidade para seguir para desenvolvimento.',
    context: `Refinamento sob avaliação:\n${refinementContent}\n\nDemanda original:\nTítulo: ${demand.title}\nDescrição: ${demand.description}`,
    constraints: [
      'Avalie estritamente com base nos critérios e rubricas objetivos definidos.',
      'Não exponha cadeia de pensamento ou raciocínio detalhado se o modelo for do tipo reasoning.',
      'Justificativas devem ser curtas, diretas e baseadas em evidências do texto.',
    ],
    successCriteria: [
      'Retornar rubricas objetivas de avaliação (0-10) para cada item e a recomendação final de forma clara e legível.',
    ],
    expectedOutput: `Rubrica de Avaliação:
- Clareza do problema: [Nota 0-10] e [Justificativa curta]
- Usuário impactado: [Nota 0-10] e [Justificativa curta]
- Valor de negócio: [Nota 0-10] e [Justificativa curta]
- Escopo delimitado: [Nota 0-10] e [Justificativa curta]
- Dependências mapeadas: [Nota 0-10] e [Justificativa curta]
- Riscos e mitigação: [Nota 0-10] e [Justificativa curta]
- Critérios de aceite: [Nota 0-10] e [Justificativa curta]
- Lacunas e ambiguidades: [Nota 0-10] e [Justificativa curta]

Recomendação final:
- Aprovar (se média >= 8 e sem pontos críticos em aberto)
- Devolver para refinamento (se média < 8 ou pontos críticos em aberto)
- Quebrar em demandas menores (se escopo for considerado muito grande)
- Enviar para análise técnica (se complexidade técnica exigir validação adicional)`,
  };

  return buildPrompt(input, modelConfig);
}

/**
 * Default models for different task types.
 */
/**
 * Native Xiaomi (MiMo) "pro-tier" model, served via the dedicated Xiaomi API
 * key/endpoint (NOT via OpenRouter). Primary for PM/PO/Tech Lead and any other
 * pro-tier usage; `deepseek/deepseek-v4-pro` (via OpenRouter) is its fallback.
 */
export const XIAOMI_PRO_MODEL = process.env.XIAOMI_MODEL_PRO || 'mimo-v2.5-pro';
export const PRO_TIER_FALLBACK_MODEL = 'deepseek/deepseek-v4-pro';

const DEFAULT_MODELS = {
  technical: process.env.MISTRAL_MODEL_CODESTRAL || 'codestral-latest',
  // 2026-07-20: modelos ":free" do OpenRouter fora do hot path — qualidade e
  // rate-limit imprevisíveis; deepseek-v4-flash é o fast pago mais barato.
  classification: process.env.FAST_MODEL || 'deepseek/deepseek-v4-flash',
  json: process.env.FAST_MODEL || 'deepseek/deepseek-v4-flash',
  simple: process.env.FAST_MODEL || 'deepseek/deepseek-v4-flash',
  analysis: process.env.CAPABLE_MODEL || XIAOMI_PRO_MODEL,
  document: process.env.CAPABLE_MODEL || XIAOMI_PRO_MODEL,
  generation: process.env.CAPABLE_MODEL || XIAOMI_PRO_MODEL,
} as const;

/**
 * Default max tokens for different task types.
 */
export const DEFAULT_MAX_COMPLETION_TOKENS = {
  classification: 300,
  json: 400,
  simple: 800,
  analysis: 1800,
  document: 2000,
  generation: 1600,
  technical: 3000,
} as const;

/**
 * Mistral model name aliases for normalization. Maps legacy/deprecated Mistral
 * model IDs to their current canonical equivalents so old telemetry, env vars
 * and stored records still resolve correctly.
 */
const MISTRAL_MODEL_ALIASES: Record<string, string> = {
  'mistral-medium-3.5': 'mistral-medium-3.5',
  'mistral-medium-latest': 'mistral-medium-3.5',
  'mistral-medium-2604': 'mistral-medium-3.5',
  'mistral-small-2603': 'mistral-small-2603',
  'mistral-large-latest': 'mistral-medium-3.5',
  'mistral-large-3': 'mistral-medium-3.5',
  'codestral-latest': 'codestral-latest',
  'codestral-25.08': 'codestral-latest',
};

/**
 * Task type for model selection.
 */
export type AITaskType =
  'classification' | 'json' | 'simple' | 'analysis' | 'document' | 'generation' | 'technical';

/**
 * Options for model resolution.
 */
interface ModelResolutionOptions {
  model?: string;
  provider?: AIProvider;
  taskType?: AITaskType;
  maxTokens?: number;
}

/**
 * Resolves the appropriate model based on task type and options.
 *
 * @param options - Resolution options
 * @returns Model name to use
 */
export function resolveModel(options: ModelResolutionOptions): string {
  if (options.model) {
    return options.model;
  }

  if (options.taskType === 'technical') {
    return DEFAULT_MODELS.technical;
  }

  if (
    options.taskType === 'classification' ||
    options.taskType === 'json' ||
    options.taskType === 'simple'
  ) {
    return DEFAULT_MODELS.classification;
  }

  if (
    options.taskType === 'analysis' ||
    options.taskType === 'document' ||
    options.taskType === 'generation'
  ) {
    return DEFAULT_MODELS.analysis;
  }

  if (options.maxTokens && options.maxTokens <= 300) {
    return DEFAULT_MODELS.classification;
  }

  if (options.maxTokens && options.maxTokens >= 2500) {
    return DEFAULT_MODELS.analysis;
  }

  return DEFAULT_MODELS.simple;
}

/**
 * Resolves the appropriate provider for a given model.
 *
 * @param model - Model name
 * @param requestedProvider - Explicitly requested provider (optional)
 * @returns Provider to use
 */
export function resolveProvider(model: string, requestedProvider?: AIProvider): AIProvider {
  const normalizedModel = model.toLowerCase();
  const isMistralFamily =
    normalizedModel.includes('mistral') || normalizedModel.includes('codestral');

  // Mistral-family models must always use the Mistral provider/client.
  if (isMistralFamily) {
    return 'mistral';
  }

  // Native Xiaomi (MiMo) model ids have no vendor prefix (e.g. "MiMo-V2.5-Pro")
  // and must use the native Xiaomi key/endpoint. The OpenRouter variant keeps its
  // "xiaomi/" prefix (contains "/") and is therefore NOT matched here.
  const isXiaomiNative =
    !normalizedModel.includes('/') &&
    (normalizedModel === XIAOMI_PRO_MODEL.toLowerCase() || normalizedModel.startsWith('mimo-'));
  if (isXiaomiNative) {
    return 'xiaomi';
  }

  if (requestedProvider) {
    return requestedProvider;
  }

  // DeepSeek V4 Flash e Pro usam Tencent TokenHub (compatível com OpenAI)
  // Model IDs: deepseek-v4-flash, deepseek-v4-pro, deepseek/deepseek-v4-flash, deepseek/deepseek-v4-pro
  // NÃO confundir com deepseek-ai/ (NVIDIA) que tem prefixo diferente
  if (
    (normalizedModel.includes('deepseek-v4-flash') ||
      normalizedModel.includes('deepseek-v4-pro')) &&
    !normalizedModel.includes('deepseek-ai/')
  ) {
    return 'tencent';
  }

  // GLM-5.2 e Kimi-K2.6 usam Tencent TokenHub.
  // GLM-4.7-Flash NÃO existe no Tencent e continua via OpenRouter.
  if (
    (normalizedModel.includes('glm-5.2') || normalizedModel.includes('kimi-k2')) &&
    !normalizedModel.includes('flash') &&
    !normalizedModel.includes('glm-4.7')
  ) {
    return 'tencent';
  }

  // MiniMax-M3 usa Tencent TokenHub quando referenciado pelo id nativo
  // (sem prefixo "minimax/"). O espelho OpenRouter ("minimax/minimax-m3")
  // mantém "/" e é roteado adiante por isOpenRouterModel.
  if (!normalizedModel.includes('/') && normalizedModel.includes('minimax-m3')) {
    return 'tencent';
  }

  if (normalizedModel.includes('deepseek-ai/') || normalizedModel.includes('nvidia/')) {
    return 'nvidia';
  }

  if (isOpenRouterModel(model)) {
    return 'openrouter';
  }

  return 'openai';
}

/**
 * Normalizes a model name for a specific provider.
 *
 * @param model - Model name
 * @param provider - Target provider
 * @returns Normalized model name
 */
export function normalizeModelForProvider(model: string, provider: AIProvider): string {
  // Tencent TokenHub usa IDs de modelo específicos (compatível com OpenAI)
  if (provider === 'tencent') {
    const normalized = model.toLowerCase();
    if (normalized.includes('deepseek-v4-flash')) {
      return 'deepseek-v4-flash-202605';
    }
    if (normalized.includes('deepseek-v4-pro')) {
      return 'deepseek-v4-pro-202606';
    }
    if (normalized.includes('glm-5.2')) {
      return 'glm-5.2';
    }
    if (normalized.includes('kimi-k2')) {
      return 'kimi-k2.6';
    }
    return model;
  }

  if (provider !== 'mistral') {
    return model;
  }

  return MISTRAL_MODEL_ALIASES[model.toLowerCase()] || model;
}

/**
 * Checks if a model is an OpenRouter model.
 *
 * @param model - Model name
 * @returns true if the model is from OpenRouter
 */
export function isOpenRouterModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return (
    normalized === 'openrouter/free' || normalized.includes('/') || normalized.endsWith(':free')
  );
}

/**
 * Prepares messages for a specific provider (handles role mapping).
 *
 * @param messages - Original messages
 * @param provider - Target provider
 * @returns Provider-specific messages
 */
export function prepareProviderMessages(
  messages: Array<{ role: string; content: string; name?: string }>,
  provider: AIProvider,
): Array<{ role: string; content: string; name?: string }> {
  if (provider === 'openai') {
    return messages;
  }

  // Map 'developer' role to 'system' for non-OpenAI providers
  return messages.map((message) =>
    message.role === 'developer' ? { ...message, role: 'system' } : message,
  );
}

/**
 * Resolves the max tokens for a request based on task type and options.
 *
 * @param options - Resolution options
 * @returns Max tokens to use
 */
export function resolveMaxTokens(options: ModelResolutionOptions): number {
  if (options.maxTokens) {
    return options.maxTokens;
  }

  if (options.taskType) {
    return DEFAULT_MAX_COMPLETION_TOKENS[options.taskType] || DEFAULT_MAX_COMPLETION_TOKENS.simple;
  }

  return DEFAULT_MAX_COMPLETION_TOKENS.simple;
}

/**
 * Fast model constant.
 */
export const FAST_MODEL = DEFAULT_MODELS.classification;

/**
 * Capable model constant.
 */
export const CAPABLE_MODEL = DEFAULT_MODELS.analysis;

/**
 * OpenRouter fallback model constant.
 */
// 2026-07-20: último recurso deixa de ser 'openrouter/free' (sem SLA) e passa
// ao modelo pago mais barato do stack.
export const OPENROUTER_FALLBACK_MODEL = 'deepseek/deepseek-v4-flash';
export const OPENROUTER_PRIMARY_MODEL =
  process.env.OPENROUTER_MODEL_PRIMARY || 'deepseek/deepseek-v4-pro';
