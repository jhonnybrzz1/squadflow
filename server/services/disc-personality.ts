import type { Demand } from '@shared/schema';
import { AgentRole } from '../../shared/agent-roles';

export const PM_INNOVATION_AGENT_KEY = 'pm_innovation';

export const PM_INNOVATION_KEYWORDS = [
  'IA',
  'inteligência artificial',
  'machine learning',
  'ML',
  'automação',
  'automatizar',
  'LLM',
  'GPT',
  'OpenAI',
  'refatorar com',
  'otimizar com',
] as const;

export type DiscTraitScore = {
  natural: number;
  adapted: number;
};

export type DiscTraitMap = Record<string, DiscTraitScore>;

export interface PmInnovationActivation {
  triggered: boolean;
  matchedKeywords: string[];
  confidence: number;
}

export interface AgentPromptConfig {
  system_prompt: string;
  description: string;
  model?: string;
  model_fallback?: string;
  temperature?: number;
  max_tokens?: number;
}

const DISC_PERSONALITY_MARKER = '--- PERSONALIZACAO DISC DO PO ---';

/**
 * Perfil DISC padrao do PO, usado quando o chamador nao fornece traits proprios.
 * Os pesos calibram o tom em `normalizePersonalityTraits` (concisao, clareza de
 * sequencia e enfase em risco). Para outro perfil, passe um `DiscTraitMap`
 * explicito nas funcoes que aceitam `traits` em vez de editar este default.
 */
export const DEFAULT_DISC_TRAITS: DiscTraitMap = {
  paciencia: { natural: 40, adapted: 83 },
  planejamento: { natural: 58, adapted: 76 },
  prudencia: { natural: 52, adapted: 74 },
};

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function normalizeTraitName(value: string): string {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function effectiveScore(score: DiscTraitScore): number {
  return score.natural * 0.6 + score.adapted * 0.4;
}

function findTrait(traits: DiscTraitMap, aliases: string[]): number | undefined {
  const normalizedAliases = new Set(aliases.map(normalizeTraitName));
  for (const [name, score] of Object.entries(traits)) {
    if (normalizedAliases.has(normalizeTraitName(name))) {
      return effectiveScore(score);
    }
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordMatches(text: string, keyword: string): boolean {
  const normalizedText = normalizeText(text);
  const normalizedKeyword = normalizeText(keyword);

  if (normalizedKeyword.length <= 3 || /^[a-z0-9]+$/.test(normalizedKeyword)) {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizedKeyword)}([^a-z0-9]|$)`);
    return pattern.test(normalizedText);
  }

  return normalizedText.includes(normalizedKeyword);
}

export function detectPmInnovationTrigger(
  demand: Pick<Demand, 'title' | 'description'>,
): PmInnovationActivation {
  const text = `${demand.title || ''}\n${demand.description || ''}`;
  const matchedKeywords = PM_INNOVATION_KEYWORDS.filter((keyword) => keywordMatches(text, keyword));

  return {
    triggered: matchedKeywords.length > 0,
    matchedKeywords,
    confidence: matchedKeywords.length > 0 ? Math.min(1, 0.7 + matchedKeywords.length * 0.1) : 0,
  };
}

export const PM_INNOVATION_MARKER = '--- MODO PM INNOVATION (IA/Automação) ---';

/**
 * Retorna o bloco de prompt do PM Innovation a ser anexado ao Product Manager
 * quando a demanda contiver sinais de IA/automação. Retorna string vazia se
 * não houver sinal ou se o config do pm_innovation não estiver disponível.
 */
export function buildPmInnovationPromptBlock(
  demand: Pick<Demand, 'title' | 'description'>,
  pmInnovationConfig?: AgentPromptConfig | null,
): string {
  const activation = detectPmInnovationTrigger(demand);
  if (!activation.triggered || !pmInnovationConfig?.system_prompt) {
    return '';
  }

  // Evita duplicar o bloco se já estiver presente
  if (pmInnovationConfig.system_prompt.includes(PM_INNOVATION_MARKER)) {
    return `${PM_INNOVATION_MARKER}\nAtive o modo PM Innovation. Palavras-chave detectadas: ${activation.matchedKeywords.join(', ')}.`;
  }

  return `${PM_INNOVATION_MARKER}\nAtive o modo PM Innovation para esta demanda. Palavras-chave detectadas: ${activation.matchedKeywords.join(', ')}.\n\n${pmInnovationConfig.system_prompt}`;
}

/**
 * Anexa o modo PM Innovation ao system prompt do product_manager quando
 * a demanda contiver sinais de IA/automação. Não altera outros agentes.
 */
export function applyPmInnovationToProductManager<T extends AgentPromptConfig>(
  config: T | undefined,
  demand: Pick<Demand, 'title' | 'description'>,
  pmInnovationConfig?: AgentPromptConfig | null,
): T | undefined {
  if (!config || config.system_prompt.includes(PM_INNOVATION_MARKER)) return config;

  const block = buildPmInnovationPromptBlock(demand, pmInnovationConfig);
  if (!block) return config;

  return {
    ...config,
    system_prompt: `${config.system_prompt}\n\n${block}`,
  } as T;
}

export function normalizePersonalityTraits(traits: DiscTraitMap = DEFAULT_DISC_TRAITS): string {
  const paciencia = findTrait(traits, ['paciência', 'paciencia']);
  const planejamento = findTrait(traits, ['planejamento', 'organizacao', 'organização']);
  const prudencia = findTrait(traits, ['prudência', 'prudencia', 'cautela']);

  // Balanced detail: concise but complete (was: "baixo detalhe")
  const detailRule =
    paciencia !== undefined && paciencia < 65
      ? 'conciso mas completo'
      : 'detalhe suficiente, sem alongar';

  const sequenceRule =
    planejamento !== undefined && planejamento >= 65 ? 'sequencia clara' : 'proximo passo objetivo';

  // Balanced risk: mention key risks briefly (was: "risco apenas quando bloquear decisao")
  const riskRule =
    prudencia !== undefined && prudencia >= 65
      ? 'mencione riscos principais com mitigacao breve'
      : 'mencione riscos criticos de forma objetiva';

  return `Tom do PO: Facilitador-Comunicador. Responda direto, colaborativo e orientado a resultado; use ${detailRule}, ${sequenceRule} e ${riskRule}.`;
}

export function buildDiscPersonalityPromptBlock(
  traits: DiscTraitMap = DEFAULT_DISC_TRAITS,
): string {
  return [
    DISC_PERSONALITY_MARKER,
    normalizePersonalityTraits(traits),
    'Comece pela decisao e impacto; inclua justificativa breve quando relevante; evite rodeios desnecessarios.',
  ].join('\n');
}

export function applyDiscPersonalityToAgentConfigs<T extends AgentPromptConfig>(
  configs: Record<string, T>,
  options: { enabled: boolean; traits?: DiscTraitMap } = { enabled: true },
): { configs: Record<string, T>; applied: boolean; promptBlock: string | null } {
  if (!options.enabled) {
    return { configs: { ...configs }, applied: false, promptBlock: null };
  }

  const promptBlock = buildDiscPersonalityPromptBlock(options.traits);
  const personalizedConfigs: Record<string, T> = {};

  for (const [agentName, config] of Object.entries(configs)) {
    const alreadyApplied = config.system_prompt.includes(DISC_PERSONALITY_MARKER);
    personalizedConfigs[agentName] = {
      ...config,
      system_prompt: alreadyApplied
        ? config.system_prompt
        : `${config.system_prompt}\n\n${promptBlock}`,
    };
  }

  return { configs: personalizedConfigs, applied: true, promptBlock };
}

export function applyPmInnovationAgentActivation<T extends AgentPromptConfig>(
  scopedConfigs: Record<string, T>,
  allConfigs: Record<string, T>,
  activation: PmInnovationActivation,
): Record<string, T> {
  const withoutInnovation = Object.fromEntries(
    Object.entries(scopedConfigs).filter(([agentName]) => agentName !== PM_INNOVATION_AGENT_KEY),
  ) as Record<string, T>;

  if (!activation.triggered || !allConfigs[PM_INNOVATION_AGENT_KEY]) {
    return withoutInnovation;
  }

  const ordered: Record<string, T> = {};
  if (withoutInnovation[AgentRole.product_owner]) {
    ordered[AgentRole.product_owner] = withoutInnovation[AgentRole.product_owner];
  }
  ordered[PM_INNOVATION_AGENT_KEY] = allConfigs[PM_INNOVATION_AGENT_KEY];

  for (const [agentName, config] of Object.entries(withoutInnovation)) {
    if (agentName !== AgentRole.product_owner) {
      ordered[agentName] = config;
    }
  }

  return ordered;
}
