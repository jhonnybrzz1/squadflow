/**
 * Demanda 10081 (parte A) — triagem semântica de agentes.
 *
 * Substitui a squad fixa de 7 agentes (`DEFAULT_ROUNDTABLE_AGENTS`) por uma
 * seleção baseada no conteúdo real da demanda + na `description` declarada
 * de cada agente (YAMLs em `agents/`), quando o cliente não manda uma lista
 * explícita. Inspirado no design arquivado da spec 10061 ("Agente de Triagem
 * Dinâmica"), mas reapontado para o único caminho vivo hoje
 * (`POST /api/demands` → mesa redonda) — o cognitive-core
 * (`demand-classifier.ts`/`agent-orchestrator.ts`) está desconectado desse
 * fluxo e não é o ponto de integração.
 *
 * Fail-safe: qualquer erro, timeout, JSON inválido ou confiança baixa cai em
 * `fallback: true` — o caller usa a squad estática de sempre.
 */
import { z } from 'zod';
import { openAIService } from './openai-ai';
import { AgentFactory } from './ai-squad/AgentFactory';
import { logger } from '../utils/logger';
import { DEFAULT_ROUNDTABLE_AGENTS, MIN_ROUNDTABLE_AGENTS } from '@shared/agent-roles';

export interface DemandForTriage {
  title: string;
  description: string;
  type: string;
}

export interface DynamicAgentTriageResult {
  selectedAgents: string[];
  reasoning: string;
  confidence: number;
  fallback: boolean;
}

const TRIAGE_SCHEMA = z.object({
  selectedAgents: z.array(z.string()),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

const MIN_CONFIDENCE = 0.5;
const FORCED_AGENT = 'product_owner';

const FAIL_SAFE: DynamicAgentTriageResult = {
  selectedAgents: [],
  reasoning: '',
  confidence: 0,
  fallback: true,
};

function buildCatalog(agentConfigs: Record<string, { description: string }>): string {
  return Object.entries(agentConfigs)
    .map(([key, config]) => `- ${key}: ${config.description || '(sem descrição)'}`)
    .join('\n');
}

function buildPrompt(demand: DemandForTriage, catalog: string): string {
  return `Demanda a refinar:
Título: ${demand.title}
Tipo: ${demand.type}
Descrição: ${demand.description}

Catálogo de agentes disponíveis (chave: descrição da capacidade):
${catalog}

Escolha SOMENTE os agentes cuja capacidade é realmente relevante para esta demanda específica — não inclua um agente só porque ele é genérico ou "sempre útil". Prefira uma squad enxuta e correta a uma squad grande e genérica. "${FORCED_AGENT}" é adicionado automaticamente pelo sistema, não precisa incluí-lo.

Responda em JSON: {"selectedAgents": string[], "reasoning": string (curto, até 300 caracteres), "confidence": number entre 0 e 1}.`;
}

/**
 * Completa a squad até o quórum mínimo usando a ordem canônica da squad padrão,
 * sem duplicar o que a triagem já escolheu e sem inventar agente que não exista
 * no catálogo carregado. Devolve a lista como está se já houver quórum.
 */
function topUpToQuorum(selected: string[], availableKeys: Set<string>): string[] {
  if (selected.length >= MIN_ROUNDTABLE_AGENTS) return selected;

  const completed = [...selected];
  for (const candidate of DEFAULT_ROUNDTABLE_AGENTS) {
    if (completed.length >= MIN_ROUNDTABLE_AGENTS) break;
    if (completed.includes(candidate)) continue;
    if (!availableKeys.has(candidate)) continue;
    completed.push(candidate);
  }
  return completed;
}

/**
 * Seleciona os agentes que fazem sentido semanticamente para a demanda.
 * Nunca lança — qualquer falha vira `fallback: true`.
 */
export async function selectAgentsForDemand(
  demand: DemandForTriage,
): Promise<DynamicAgentTriageResult> {
  try {
    const { agentConfigs } = new AgentFactory().loadConfigurations();
    const availableKeys = new Set(Object.keys(agentConfigs));
    if (availableKeys.size === 0) {
      return FAIL_SAFE;
    }

    const catalog = buildCatalog(agentConfigs);
    const result = await openAIService.generateJSONResponse<{
      selectedAgents: string[];
      reasoning: string;
      confidence: number;
    }>(
      'Você é um classificador que decide quais agentes especialistas participam do refinamento de uma demanda.',
      buildPrompt(demand, catalog),
      {
        operation: 'dynamic-agent-triage',
        maxTokens: 400,
        temperature: 0.2,
        schema: TRIAGE_SCHEMA,
        // Conteúdo já é a demanda que o próprio sistema está processando, não
        // input adversarial de terceiro — mesma convenção de document-generator.ts.
        failOpenOnError: true,
      },
    );

    if (result.confidence < MIN_CONFIDENCE) {
      logger.info('Triagem dinâmica: confiança abaixo do piso, usando fallback', {
        context: { confidence: result.confidence },
      });
      return FAIL_SAFE;
    }

    const filtered = result.selectedAgents.filter((agent) => availableKeys.has(agent));
    const forced = filtered.includes(FORCED_AGENT) ? filtered : [FORCED_AGENT, ...filtered];

    // ALTO-01: o prompt pede uma squad ENXUTA, então o LLM devolve poucos
    // especialistas com frequência — mas a mesa redonda tem quórum mínimo
    // (`MIN_ROUNDTABLE_AGENTS`). Sem completar aqui, o caller rejeitava a
    // demanda com 400. Preenche na ordem canônica da squad padrão, preservando
    // as escolhas da triagem, e só desiste (fallback) se nem assim der quórum.
    const selectedAgents = topUpToQuorum(forced, availableKeys);

    if (selectedAgents.length < MIN_ROUNDTABLE_AGENTS) {
      logger.info('Triagem dinâmica: quórum mínimo inalcançável, usando fallback', {
        context: { selected: selectedAgents.length, minimum: MIN_ROUNDTABLE_AGENTS },
      });
      return FAIL_SAFE;
    }

    return {
      selectedAgents,
      reasoning: result.reasoning.slice(0, 300),
      confidence: result.confidence,
      fallback: false,
    };
  } catch (error) {
    logger.warn('Triagem dinâmica de agentes falhou — usando fallback', {
      error: error instanceof Error ? error : undefined,
    });
    return FAIL_SAFE;
  }
}
