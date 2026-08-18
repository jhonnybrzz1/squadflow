import { randomUUID } from 'crypto';
import { sql, type SQL } from 'drizzle-orm';
import { db as defaultDb, isPostgres, type DbClient } from '../db';
import { logger } from '../utils/logger';
import { dbRun } from '../utils/db-utils';
import { agentDecisionRecords } from '@shared/schema-unified';
import { type RefinementDecisionContext, type RouterDecision } from '@shared/schema';
import { openAIService } from './openai-ai';
import {
  DEMAND_TYPES,
  getDemandTypeRoutingConfig,
  isDemandType,
  type DemandTypeRoutingConfig,
} from '@shared/demand-types';

/**
 * Confidence threshold below which fallback (all agents) is used.
 * PRD spec: confidence < 0.6 → use all agents.
 */
const CONFIDENCE_THRESHOLD = 0.6;

const CRITICAL_AGENTS = ['product_owner', 'qa', 'tech_lead'];

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function buildCategoryAgentMap(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const config of Object.values(DEMAND_TYPES)) {
    map[config.category] = unique([...(map[config.category] ?? []), ...config.squad]);
  }
  map.mixed = unique(Object.values(DEMAND_TYPES).flatMap((config) => config.squad));
  return map;
}

function buildCategoryRegexPatterns(): Record<string, RegExp> {
  const grouped: Record<string, string[]> = {};
  for (const config of Object.values(DEMAND_TYPES)) {
    const routingConfig = config as DemandTypeRoutingConfig;
    grouped[routingConfig.category] = [
      ...(grouped[routingConfig.category] ?? []),
      ...routingConfig.regex,
    ];
    for (const [category, patterns] of Object.entries(routingConfig.routingPatterns ?? {})) {
      grouped[category] = [...(grouped[category] ?? []), ...(patterns ?? [])];
    }
  }
  return Object.fromEntries(
    Object.entries(grouped).map(([category, patterns]) => [
      category,
      new RegExp(patterns.join('|'), 'i'),
    ]),
  );
}

const CATEGORY_AGENT_MAP = buildCategoryAgentMap();
const CATEGORY_REGEX_PATTERNS = buildCategoryRegexPatterns();

function formatCategoryAgentMappingForPrompt(): string {
  return Object.entries(CATEGORY_AGENT_MAP)
    .filter(([category]) => category !== 'mixed')
    .map(([category, agents]) => `- ${category}: ${agents.join(', ')}`)
    .join('\n');
}

export interface SmartRouterClassification {
  category: string;
  confidence: number;
  selectedAgents: string[];
  reasoning: string;
  method: 'registry' | 'regex' | 'llm' | 'fallback';
}

export class AgentRouterService {
  private initPromise: Promise<void>;

  constructor(private readonly database: DbClient = defaultDb) {
    this.initPromise = this.initialize();
  }
  private async initialize(): Promise<void> {
    await this.ensureSchema();
  }

  /**
   * Smart classification: uses regex first, then LLM if ambiguous.
   * Returns a classification with confidence score and selected agents.
   */
  async classifyDemandForRouting(
    title: string,
    description: string,
    demandType: string,
    availableAgents: string[],
    domain: string = 'padrao',
  ): Promise<SmartRouterClassification> {
    const text = `${title} ${description}`.toLowerCase();
    let result: SmartRouterClassification;

    const registryResult = this.classifyByDemandType(demandType, availableAgents);
    if (registryResult) {
      result = registryResult;
    } else {
      // Step 1: Try regex-based classification
      const regexResult = this.classifyByRegex(text);

      if (regexResult.confidence >= CONFIDENCE_THRESHOLD) {
        const selectedAgents = this.selectAgentsForCategory(regexResult.category, availableAgents);
        result = {
          ...regexResult,
          selectedAgents,
          method: 'regex',
        };
      } else {
        // Step 2: Use LLM for ambiguous cases
        try {
          const llmResult = await this.classifyByLLM(
            title,
            description,
            demandType,
            availableAgents,
          );
          if (llmResult.confidence >= CONFIDENCE_THRESHOLD) {
            result = { ...llmResult, method: 'llm' };
          } else {
            result = {
              category: 'mixed',
              confidence: 0,
              selectedAgents: [...availableAgents],
              reasoning: 'Classificação incerta. Fallback para todos os agentes.',
              method: 'fallback',
            };
          }
        } catch (error) {
          logger.warn('LLM classification failed, using fallback', {
            error: error instanceof Error ? error : undefined,
          });
          result = {
            category: 'mixed',
            confidence: 0,
            selectedAgents: [...availableAgents],
            reasoning: 'Classificação incerta. Fallback para todos os agentes.',
            method: 'fallback',
          };
        }
      }
    }

    const requiredSpecialists = isDemandType(demandType)
      ? [...(getDemandTypeRoutingConfig(demandType).agentOverrides?.include ?? [])]
      : [];
    if (domain === 'legaltech_lgpd') {
      requiredSpecialists.push('security_specialist');
    }

    for (const specialist of requiredSpecialists) {
      if (availableAgents.includes(specialist) && !result.selectedAgents.includes(specialist)) {
        result.selectedAgents.push(specialist);
      }
    }

    return result;
  }

  private classifyByDemandType(
    demandType: string,
    availableAgents: string[],
  ): SmartRouterClassification | null {
    if (!isDemandType(demandType)) return null;

    const config = getDemandTypeRoutingConfig(demandType);
    if (!config.agentOverrides?.include?.length) return null;

    const selectedAgents = this.selectAgentsForSquad(config.squad, availableAgents);

    return {
      category: config.category,
      confidence: 1,
      selectedAgents,
      reasoning: `Tipo declarado '${demandType}' roteado via shared/demand-types.ts.`,
      method: 'registry',
    };
  }

  /**
   * Regex-based fast classification.
   */
  private classifyByRegex(text: string): {
    category: string;
    confidence: number;
    reasoning: string;
  } {
    const scores: Record<string, number> = {};

    for (const [category, regex] of Object.entries(CATEGORY_REGEX_PATTERNS)) {
      const matches = text.match(new RegExp(regex.source, 'gi'));
      scores[category] = matches ? matches.length : 0;
    }

    const sortedCategories = Object.entries(scores).sort(([, a], [, b]) => b - a);
    const topCategory = sortedCategories[0];
    const secondCategory = sortedCategories[1];

    if (!topCategory || topCategory[1] === 0) {
      return { category: 'unknown', confidence: 0, reasoning: 'Nenhum padrão regex identificado.' };
    }

    // Calculate confidence based on dominance of top category
    const totalMatches = Object.values(scores).reduce((sum, v) => sum + v, 0);
    const dominance = topCategory[1] / totalMatches;

    // If second category is close, it's multidisciplinary
    const isMultidisciplinary =
      secondCategory && secondCategory[1] > 0 && secondCategory[1] / topCategory[1] > 0.6;

    if (isMultidisciplinary) {
      return {
        category: 'mixed',
        confidence: dominance * 0.5, // Lower confidence for mixed
        reasoning: `Demanda multidisciplinar: ${topCategory[0]} (${topCategory[1]}) + ${secondCategory[0]} (${secondCategory[1]}).`,
      };
    }

    return {
      category: topCategory[0],
      confidence: Math.min(0.95, dominance * 0.9 + (topCategory[1] > 3 ? 0.1 : 0)),
      reasoning: `Regex classificou como ${topCategory[0]} com ${topCategory[1]} padrões encontrados.`,
    };
  }

  /**
   * LLM-based classification for ambiguous demands.
   * Uses a fast, cheap model (configured via FAST_MODEL).
   */
  private async classifyByLLM(
    title: string,
    description: string,
    demandType: string,
    availableAgents: string[],
  ): Promise<SmartRouterClassification> {
    const prompt = `Classifique esta demanda em UMA categoria principal e retorne JSON.

DEMANDA:
Título: ${title}
Descrição: ${description}
Tipo: ${demandType}

CATEGORIAS DISPONÍVEIS: ${Object.keys(CATEGORY_AGENT_MAP)
      .filter((category) => category !== 'mixed')
      .join(', ')}

MAPEAMENTO DE CATEGORIAS → AGENTES:
${formatCategoryAgentMappingForPrompt()}

AGENTES DISPONÍVEIS: ${availableAgents.join(', ')}

Retorne APENAS JSON válido (sem markdown):
{"category": "...", "confidence": 0.0-1.0, "selectedAgents": ["agent1", "agent2"], "reasoning": "..."}

REGRAS:
- Selecione 2-4 agentes mais relevantes da lista disponível.
- "product_owner" deve SEMPRE estar incluído.
- Se envolve interface/usuário, inclua "ux".
- confidence: 0.9+ se muito claro, 0.7-0.9 se claro, 0.5-0.7 se ambíguo, <0.5 se incerto.`;

    const response = await openAIService.generateChatCompletion(
      'Você é um classificador de demandas. Retorne APENAS JSON válido.',
      prompt,
      { taskType: 'classification', maxTokens: 200 },
    );

    try {
      // Strip markdown code blocks if present (```json ... ``` or ``` ... ```)
      let cleanResponse = response.trim();
      const jsonMatch = cleanResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        cleanResponse = jsonMatch[1].trim();
      }
      // Also try to extract JSON object directly
      const objectMatch = cleanResponse.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        cleanResponse = objectMatch[0];
      }

      const parsed = JSON.parse(cleanResponse);
      // Validate and filter agents to only include available ones
      const validAgents = (parsed.selectedAgents || []).filter((a: string) =>
        availableAgents.includes(a),
      );
      // Ensure product_owner is always included
      if (!validAgents.includes('product_owner') && availableAgents.includes('product_owner')) {
        validAgents.unshift('product_owner');
      }

      return {
        category: parsed.category || 'mixed',
        confidence: Math.min(1, Math.max(0, parsed.confidence || 0)),
        selectedAgents: validAgents.length > 0 ? validAgents : [...availableAgents],
        reasoning: parsed.reasoning || 'Classificação LLM sem justificativa.',
        method: 'llm',
      };
    } catch (_) {
      throw new Error('Failed to parse LLM classification response');
    }
  }

  /**
   * Maps a category to its recommended agents, filtered by availability.
   */
  private selectAgentsForCategory(category: string, availableAgents: string[]): string[] {
    const recommended = CATEGORY_AGENT_MAP[category] || CATEGORY_AGENT_MAP['mixed'];
    return this.selectAgentsForSquad(recommended, availableAgents);
  }

  private selectAgentsForSquad(
    recommendedAgents: readonly string[],
    availableAgents: string[],
  ): string[] {
    const selected = recommendedAgents.filter((a) => availableAgents.includes(a));

    // Ensure at least 2 agents are selected
    if (selected.length < 2) {
      for (const agent of availableAgents) {
        if (!selected.includes(agent)) {
          selected.push(agent);
          if (selected.length >= 2) break;
        }
      }
    }

    return selected;
  }

  /**
   * Decide quais agentes incluir ou omitir no refinamento com base no contexto.
   * LEGACY: Still supports the old deterministic interface for backward compatibility.
   */
  decideAgentsForRefinement(
    context: RefinementDecisionContext,
    availableAgents: string[],
    shadowMode: boolean = true,
  ): RouterDecision {
    const startedAt = Date.now();
    const proposedIncludeAgents = [...availableAgents];
    const proposedOmitAgents: string[] = [];
    const reasonCodes: string[] = [];
    let fallbackUsed = false;

    // Função auxiliar para remover um agente de forma segura
    const omitAgent = (agentName: string, reason: string) => {
      if (!CRITICAL_AGENTS.includes(agentName) && proposedIncludeAgents.includes(agentName)) {
        proposedIncludeAgents.splice(proposedIncludeAgents.indexOf(agentName), 1);
        proposedOmitAgents.push(agentName);
        reasonCodes.push(reason);
      }
    };

    if (context.confidence === 'low' || context.taskType === 'unknown') {
      fallbackUsed = true;
      reasonCodes.push(
        context.confidence === 'low' ? 'fallback_low_confidence' : 'fallback_unknown_task_type',
      );

      // Fallback: keep all agents (safe)
      // Do not omit any agent when confidence is low
    } else {
      // Deterministic omission rules
      // NOTE: Use canonical agent IDs ('ux', 'analista_de_dados') to match CATEGORY_AGENT_MAP
      if (context.taskType === 'tech_task' && context.uiImpactKnown === false) {
        omitAgent('ux', 'tech_task_no_ui_impact');
      }

      if (context.taskType === 'defined_bug') {
        omitAgent('ux', 'bug_no_ux_needed');
        omitAgent('analista_de_dados', 'bug_no_analytics_needed');
        omitAgent('product_manager', 'bug_pm_not_needed');
      }

      if (context.taskType === 'discovery') {
        omitAgent('qa', 'discovery_no_qa_needed');
      }

      if (context.acceptanceScope === 'technical') {
        omitAgent('ux', 'technical_scope_no_ux');
        omitAgent('product_manager', 'technical_scope_no_pm');
      }

      if (context.acceptanceScope === 'business') {
        omitAgent('tech_lead', 'business_scope_no_tech');
      }
    }

    const decisionLatencyMs = Date.now() - startedAt;

    // Determinar os agentes reais com base no modo shadow
    let actualIncludeAgents = proposedIncludeAgents;
    let actualOmitAgents = proposedOmitAgents;

    if (shadowMode) {
      actualIncludeAgents = [...availableAgents];
      actualOmitAgents = [];
    }

    return {
      proposedIncludeAgents,
      proposedOmitAgents,
      actualIncludeAgents,
      actualOmitAgents,
      reasonCodes,
      fallbackUsed,
      shadowMode,
      decisionLatencyMs,
    };
  }

  /**
   * Persiste o Decision Record no banco de dados.
   */
  async persistDecisionRecord(
    demandId: number,
    executionId: string | null,
    context: RefinementDecisionContext,
    decision: RouterDecision,
  ): Promise<void> {
    await this.initPromise;
    const runId = randomUUID();
    const createdAt = isPostgres ? Math.floor(Date.now() / 1000) : new Date();

    await (this.database as any).insert(agentDecisionRecords).values({
      runId,
      demandId,
      executionId,
      demandType: context.demandType,
      taskType: context.taskType,
      problemDefined: context.problemDefined ? 1 : 0,
      uiImpactKnown: String(context.uiImpactKnown),
      acceptanceScope: context.acceptanceScope,
      confidence: context.confidence,
      proposedIncludeAgents: decision.proposedIncludeAgents,
      proposedOmitAgents: decision.proposedOmitAgents,
      actualIncludeAgents: decision.actualIncludeAgents,
      actualOmitAgents: decision.actualOmitAgents,
      reasonCodes: decision.reasonCodes,
      fallbackUsed: decision.fallbackUsed ? 1 : 0,
      shadowMode: decision.shadowMode ? 1 : 0,
      decisionLatencyMs: decision.decisionLatencyMs,
      createdAt,
    });

    logger.logBusinessEvent('agent_router_decision', context.taskType, runId, {
      demandId,
      executionId,
      proposedOmitCount: decision.proposedOmitAgents.length,
      actualOmitCount: decision.actualOmitAgents.length,
      actualIncludeCount: decision.actualIncludeAgents.length,
      totalAvailable: decision.actualIncludeAgents.length + decision.actualOmitAgents.length,
      reductionPercent:
        decision.actualOmitAgents.length > 0
          ? Math.round(
              (decision.actualOmitAgents.length /
                (decision.actualIncludeAgents.length + decision.actualOmitAgents.length)) *
                100,
            )
          : 0,
      shadowMode: decision.shadowMode,
      fallbackUsed: decision.fallbackUsed,
      reasonCodes: decision.reasonCodes,
    });
  }

  /**
   * Logs routing metrics for baseline measurement.
   */
  logRoutingMetrics(
    demandId: number,
    classification: SmartRouterClassification,
    totalAvailableAgents: number,
    routingLatencyMs: number,
  ): void {
    const reductionPercent =
      totalAvailableAgents > 0
        ? Math.round(
            ((totalAvailableAgents - classification.selectedAgents.length) / totalAvailableAgents) *
              100,
          )
        : 0;

    logger.info('Agent Router Metrics', {
      context: {
        demandId,
        category: classification.category,
        method: classification.method,
        confidence: classification.confidence,
        selectedAgentCount: classification.selectedAgents.length,
        totalAvailableAgents,
        agentsOmitted: totalAvailableAgents - classification.selectedAgents.length,
        reductionPercent,
        routingLatencyMs,
        selectedAgents: classification.selectedAgents,
      },
    });
  }

  private async ensureSchema(): Promise<void> {
    try {
      await dbRun(
        this.database,
        sql`
        CREATE TABLE IF NOT EXISTS agent_decision_records (
          run_id TEXT PRIMARY KEY NOT NULL,
          demand_id INTEGER NOT NULL,
          execution_id TEXT,
          demand_type TEXT NOT NULL,
          task_type TEXT NOT NULL,
          problem_defined INTEGER,
          ui_impact_known TEXT,
          acceptance_scope TEXT NOT NULL,
          confidence TEXT NOT NULL,
          proposed_include_agents TEXT NOT NULL,
          proposed_omit_agents TEXT NOT NULL,
          actual_include_agents TEXT NOT NULL,
          actual_omit_agents TEXT NOT NULL,
          reason_codes TEXT NOT NULL,
          fallback_used INTEGER NOT NULL,
          shadow_mode INTEGER NOT NULL,
          decision_latency_ms INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )
      `,
      );
      await this.runAlter(
        sql`ALTER TABLE agent_decision_records ADD COLUMN demand_type TEXT NOT NULL DEFAULT 'unknown'`,
      );
      await this.runAlter(
        sql`ALTER TABLE agent_decision_records ADD COLUMN problem_defined INTEGER`,
      );
      await this.runAlter(sql`ALTER TABLE agent_decision_records ADD COLUMN ui_impact_known TEXT`);
      await this.runAlter(
        sql`ALTER TABLE agent_decision_records ADD COLUMN acceptance_scope TEXT NOT NULL DEFAULT 'unknown'`,
      );
    } catch (error) {
      logger.warn('Could not ensure agent_decision_records schema:', error);
    }
  }

  private async runAlter(statement: SQL): Promise<void> {
    try {
      await dbRun(this.database, statement);
    } catch (error) {
      const message = [
        error instanceof Error ? error.message : String(error),
        typeof error === 'object' && error !== null && 'cause' in error
          ? String((error as { cause?: unknown }).cause)
          : '',
      ].join(' ');
      if (!message.toLowerCase().includes('duplicate column name')) {
        throw error;
      }
    }
  }
}

export const agentRouterService = new AgentRouterService();
