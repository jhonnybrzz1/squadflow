/**
 * Bedrock → OpenRouter bridge.
 *
 * Bedrock está instável, então mantemos EXATAMENTE os mesmos modelos usados na
 * configuração (GLM-5, Kimi K2.5, Qwen3, Claude Opus/Sonnet) porém servidos via
 * OpenRouter, usando a chave `OPENROUTER_API_KEY` do ambiente (shell).
 *
 * Este módulo é intencionalmente livre de dependências internas para poder ser
 * importado em qualquer camada de routing sem criar ciclos de import.
 */

/**
 * Mapeia os IDs de modelo do Bedrock (e seus aliases) para os IDs equivalentes
 * no OpenRouter — mesmo modelo subjacente, apenas outro provedor.
 */
export const BEDROCK_TO_OPENROUTER: Record<string, string> = {
  // GLM
  'zai.glm-5': 'z-ai/glm-5',
  'glm-5': 'z-ai/glm-5',

  // Kimi
  'moonshotai.kimi-k2.5': 'moonshotai/kimi-k2.5',
  'kimi-k2.5': 'moonshotai/kimi-k2.5',
  'moonshotai.kimi-k2.6': 'moonshotai/kimi-k2.6',
  'kimi-k2.6': 'moonshotai/kimi-k2.6',

  // Qwen
  'qwen.qwen3-next-80b-a3b': 'qwen/qwen3-next-80b-a3b-instruct',
  'qwen-next-80b': 'qwen/qwen3-next-80b-a3b-instruct',
  'qwen.qwen3-vl-235b-a22b': 'qwen/qwen3-vl-235b-a22b-instruct',
  'qwen-vl-235b': 'qwen/qwen3-vl-235b-a22b-instruct',

  // Claude Opus 4.6 (PM & PO)
  'us.anthropic.claude-opus-4-6-v1': 'anthropic/claude-opus-4.6',
  'anthropic.claude-opus-4-6-v1': 'anthropic/claude-opus-4.6',
  'claude-opus-4-6': 'anthropic/claude-opus-4.6',

  // Claude Sonnet 4.6
  'us.anthropic.claude-sonnet-4-6': 'anthropic/claude-sonnet-4.6',
  'anthropic.claude-sonnet-4-6': 'anthropic/claude-sonnet-4.6',
  'claude-sonnet-4-6': 'anthropic/claude-sonnet-4.6',

  // Claude Opus 4.7
  'us.anthropic.claude-opus-4-7': 'anthropic/claude-opus-4.7',
  'anthropic.claude-opus-4-7': 'anthropic/claude-opus-4.7',
  'claude-opus-4-7': 'anthropic/claude-opus-4.7',

  // Claude Opus 4.8
  'us.anthropic.claude-opus-4-8': 'anthropic/claude-opus-4.8',
  'anthropic.claude-opus-4-8': 'anthropic/claude-opus-4.8',
  'claude-opus-4-8': 'anthropic/claude-opus-4.8',
};

/**
 * Traduz um ID de modelo Bedrock para o equivalente OpenRouter.
 * Modelos que já são do OpenRouter (ou desconhecidos) passam sem alteração.
 */
export function toOpenRouterModel(model: string): string {
  if (!model) return model;
  return BEDROCK_TO_OPENROUTER[model.toLowerCase()] ?? model;
}
