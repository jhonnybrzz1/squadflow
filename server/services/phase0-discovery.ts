/**
 * Phase 0 — Discovery puro (inspirado no BMAD business-analyst)
 *
 * Quando uma demanda chega vaga (descrição curta) ou o classificador retorna
 * baixa confiança, este serviço executa um passo de discovery PURO antes do
 * Refinador, gerando um brief estruturado (5 Whys + Jobs-to-be-Done + SMART).
 *
 * Opt-in via env `PHASE0_DISCOVERY_ENABLED=true`. Quando desabilitado (default),
 * a função é no-op e o fluxo legado roda intacto.
 *
 * O brief gerado pode ser anexado ao `internalContext` do Refinador como
 * "context herdado", reduzindo retrabalho de exploração.
 */
import { logger } from '../utils/logger';
import { openAIService } from './openai-ai';

export interface Phase0Input {
  demandText: string;
  demandType?: string;
  /** Sinal externo de baixa confiança (ex.: vindo do classificador). */
  lowConfidence?: boolean;
  demandId?: number;
  model?: string;
  modelFallback?: string;
}

export interface Phase0Output {
  enabled: boolean;
  triggered: boolean;
  /** Brief em markdown (vazio se não disparou). */
  brief: string;
  reason: string;
  latencyMs: number;
}

const PHASE0_SYSTEM_PROMPT = `Você é o BMAD business-analyst em "Phase 1 — Analysis Specialist".
Sua tarefa é PURA DISCOVERY — não solucione, não estime, não priorize.

Aplique três frameworks SEMPRE, em sequência:
1) 5 Whys — pergunte "por quê?" até a raiz.
2) Jobs-to-be-Done — formato "Quando ... Quero ... Para ...".
3) SMART Goals — Specific, Measurable, Achievable, Relevant, Time-bound.

REGRAS:
- NUNCA invente stakeholders, números ou ferramentas que não estão na demanda.
- Onde faltar dado, marque "(?) — perguntar ao stakeholder".
- Hipóteses-âncora devem ser FALSIFICÁVEIS (pelo menos uma forma de testar).
- Output em markdown puro, com headers H2, sem code-fences excessivos.

OUTPUT seguindo este esqueleto:

## 1. Problem Frame (5 Whys)
**Problema observado:** ...
**Cadeia de "porquês":**
1. Por que ...? → ...
2. ...
**Causa raiz hipotética:** ...

## 2. Jobs-to-be-Done
**Quando** ..., **quero** ..., **para** ...

## 3. Stakeholders e Personas
(tabela markdown com Quem | Papel | Pain points | Como aciona)

## 4. Sucesso (SMART)
- Specific: ...
- Measurable: ...
- Achievable: ...
- Relevant: ...
- Time-bound: ...

## 5. Hipóteses-âncora (≤3, falsificáveis)
1. Se ..., então ..., porque ...
2. ...

## 6. Próximo passo recomendado
- [ ] Acionar Refinador
- [ ] Voltar ao stakeholder com: ...`;

const DEFAULT_MIN_CHARS = 80;

export function isPhase0DiscoveryEnabled(): boolean {
  return process.env.PHASE0_DISCOVERY_ENABLED === 'true';
}

/**
 * Heurística de gatilho: dispara quando demanda é curta OU classificador
 * sinalizou baixa confiança.
 */
export function shouldTriggerPhase0(input: {
  demandText: string;
  lowConfidence?: boolean;
  minChars?: number;
}): boolean {
  if (!isPhase0DiscoveryEnabled()) return false;
  if (input.lowConfidence) return true;
  const min = input.minChars ?? DEFAULT_MIN_CHARS;
  return (input.demandText || '').trim().length < min;
}

export async function runPhase0Discovery(input: Phase0Input): Promise<Phase0Output> {
  const enabled = isPhase0DiscoveryEnabled();
  const trigger = shouldTriggerPhase0({
    demandText: input.demandText,
    lowConfidence: input.lowConfidence,
  });

  if (!enabled) {
    return {
      enabled: false,
      triggered: false,
      brief: '',
      reason: 'PHASE0_DISCOVERY_ENABLED=false',
      latencyMs: 0,
    };
  }
  if (!trigger) {
    return {
      enabled: true,
      triggered: false,
      brief: '',
      reason: `Demanda com ${input.demandText?.length ?? 0} chars e confiança alta — discovery não necessário`,
      latencyMs: 0,
    };
  }

  const startedAt = Date.now();
  // Demanda 10110: descrições longas lotam o prompt do Phase 0.
  const PHASE0_DEMAND_TEXT_LIMIT = 2_500;
  const rawDemandText = input.demandText || '';
  const truncatedDemandText =
    rawDemandText.length > PHASE0_DEMAND_TEXT_LIMIT
      ? `${rawDemandText.slice(0, PHASE0_DEMAND_TEXT_LIMIT * 0.7)}\n\n[...descrição truncada...]\n${rawDemandText.slice(-PHASE0_DEMAND_TEXT_LIMIT * 0.3)}`
      : rawDemandText;
  const userPrompt = `--- DEMANDA ---
${truncatedDemandText}

--- TIPO ---
${input.demandType || 'desconhecido'}

--- TAREFA ---
Produza um discovery brief seguindo o esqueleto do system prompt. Não solucione.`;

  try {
    const brief = await openAIService.generateChatCompletion(PHASE0_SYSTEM_PROMPT, userPrompt, {
      taskType: 'analysis',
      operation: 'phase0_discovery',
      agentName: 'phase0_business_analyst',
      temperature: 0.4,
      maxTokens: 1800,
      model: input.model,
      modelFallback: input.modelFallback,
      demandId: input.demandId,
    });
    const latencyMs = Date.now() - startedAt;
    logger.info('Phase 0 discovery executado', {
      context: {
        demandId: input.demandId,
        latencyMs,
        briefChars: brief?.length ?? 0,
      },
    });
    return {
      enabled: true,
      triggered: true,
      brief: brief || '',
      reason: input.lowConfidence ? 'low_confidence' : `demanda < ${DEFAULT_MIN_CHARS} chars`,
      latencyMs,
    };
  } catch (error) {
    logger.warn('Phase 0 discovery falhou — não-bloqueante', {
      error: error instanceof Error ? error : undefined,
      context: { demandId: input.demandId },
    });
    return {
      enabled: true,
      triggered: true,
      brief: '',
      reason: 'execution_error',
      latencyMs: Date.now() - startedAt,
    };
  }
}

/**
 * Helper: retorna um header markdown que pode ser prefixado ao internalContext
 * do Refinador.
 */
export function renderPhase0BriefBlock(brief: string): string {
  if (!brief || !brief.trim()) return '';
  return `--- PHASE 0 — DISCOVERY BRIEF (BMAD business-analyst) ---
${brief.trim()}
--- FIM PHASE 0 ---`;
}
