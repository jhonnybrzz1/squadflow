import { z } from 'zod';
import { Demand, ChatMessage } from '@shared/schema';
import { demandRepository } from '../../repositories/demand-repository';
import { openAIService } from '../openai-ai';
import { sseManager } from '../sse/manager';
import { logger } from '../../utils/logger';
import { AISquadService } from '../ai-squad';
import { canonicalAgentKey } from '../agent-identity';
import { featureFlags } from '../feature-flags';
import { buildPoAdversaryPrompt } from './AgentFactory';
import { NumericIntegrityValidator } from '../numeric-integrity-validator';
import {
  runWithSelfConsistency,
  aggregateFirst,
  aggregateMajoritySeverity,
} from './self-consistency-runner';
import { getModelConfig, resolveModel } from '../llm-model-router';
import { buildDeliberationGraph, type SquadGraph } from './squad-graph';
import { eventBus } from '../../events/event-bus';
import { mapWithConcurrency } from '../llm-utils';
import { shouldUseLlmModerator, shouldUseRedTeam } from './roundtable-policy';
import {
  applyPmInnovationToProductManager,
  PM_INNOVATION_AGENT_KEY,
  type AgentPromptConfig,
} from '../disc-personality';
import {
  DEFAULT_ROUNDTABLE_AGENTS,
  RefinementOutputSchema,
  type RefinementOutput,
  type RefinementLevel,
  type RoundtableConfig,
  type RoundtableRoundResult,
  type RoundtableResult,
  type RoundtableRuntimeContext,
  buildConsolidationSystemPrompt,
  buildConsolidationUserPrompt,
  extractJsonObject,
} from '../../orchestration-contracts';
import {
  calculateRoundtableMaxTurns,
  calculateRoundtableMaxTokensPerTurn,
  calculateRoundtableTokenBudget,
  selectParallelFirstCycleAgents,
  shouldRunParallelFirstCycle,
} from './roundtable-latency-policy';
import {
  roundtableAgentDuration,
  roundtableExecutionMode,
  roundtableModeratorDuration,
  roundtableTotalDuration,
  roundtableTurnDuration,
  roundtableTtft,
  roundtableTurnsUsed,
  roundtableCostUsdTotal,
  roundtableTokensTotal,
  roundtableCacheHitTotal,
  consolidationTypeRequirementsMissingTotal,
} from '../../metrics';
import {
  resolveRoundtableCachePolicy,
  classifyCacheResult,
  isCacheHit,
} from './roundtable-cache-policy';
import { llmAuditLogService } from '../llm-audit-log';
import { extractPatterns, type RoundtableTurnMetadata } from './self-improvement-extractor';
import { DEMAND_TYPES } from '@shared/demand-types';
import { evaluateAppSecGate, type AppSecGateResult } from './appsec-gate';
import { contextBuilder } from '../context-builder';

export {
  extractJsonObject,
  buildConsolidationSystemPrompt,
  buildConsolidationUserPrompt,
  RedTeamFalhaSchema,
  RedTeamOutputSchema,
  JudgeConfirmedFailureSchema,
  JudgeOutputSchema,
} from '../../orchestration-contracts';

export type {
  RefinementOutput,
  RefinementLevel,
  RoundtableConfig,
  RoundtableRoundResult,
  RoundtableResult,
  RoundtableRuntimeContext,
} from '../../orchestration-contracts';

// ─── Schema para decisão do moderador ───────────────────────────────────────
const ModeratorDecisionSchema = z.object({
  next_speaker: z.string(),
  reason: z.string(),
  is_reply_to: z.string().optional(),
  dialogue_move: z.enum([
    'open',
    'question',
    'answer',
    'challenge',
    'support',
    'synthesize',
    'close',
  ]),
  should_continue: z.boolean(),
  // Demanda 10081 parte B: só preenchido quando o prompt do moderador lista
  // agentes disponíveis-mas-não-participantes (atrás de
  // enableDynamicAgentEscalation) — o moderador pode pedir para trazer um
  // especialista que não estava na squad inicial.
  // .nullish() (não .optional()): modelos costumam devolver `null` em JSON
  // para "sem valor" em vez de omitir a chave — confirmado em produção local
  // (demanda 10084, 2026-07-23): `{"escalate_agent": null, ...}` quebrava
  // .optional() (só aceita undefined) e derrubava a decisão inteira do
  // moderador pra fallback round-robin.
  escalate_agent: z.string().nullish(),
  escalate_reason: z.string().nullish(),
});
type ModeratorDecision = z.infer<typeof ModeratorDecisionSchema>;

const AgentMessageSchema = z.object({
  type: z
    .enum(['response', 'divergence', 'question', 'support'])
    .transform((type) => (type === 'support' ? 'response' : type)),
  content: z.string().trim().min(1),
  response_to: z.string().optional(),
  references: z.array(z.string()).optional(),
  evidence_for_numbers: z.string().optional(),
});
type AgentMessage = z.infer<typeof AgentMessageSchema>;

function parseAgentMessage(rawResponse: string): AgentMessage {
  return AgentMessageSchema.parse(extractJsonObject(rawResponse));
}

export async function parseAgentMessageWithRetry(
  rawResponse: string,
  retry: (validationError: Error) => Promise<string>,
): Promise<{ message: AgentMessage; rawResponse: string; retried: boolean }> {
  try {
    return { message: parseAgentMessage(rawResponse), rawResponse, retried: false };
  } catch (firstError) {
    const normalizedFirstError =
      firstError instanceof Error ? firstError : new Error(String(firstError));
    const retryResponse = await retry(normalizedFirstError);
    try {
      return {
        message: parseAgentMessage(retryResponse),
        rawResponse: retryResponse,
        retried: true,
      };
    } catch (secondError) {
      throw new Error('Invalid agent JSON response after structured retry', {
        cause: secondError instanceof Error ? secondError : new Error(String(secondError)),
      });
    }
  }
}

function buildAgentTurnPrompts(params: {
  internalContext: string;
  agentSystemPrompt: string;
  agentId: string;
  demand: Demand;
  decision: ModeratorDecision;
  history: string[];
  pmInnovationConfig?: AgentPromptConfig | null;
}): { systemPrompt: string; userPrompt: string } {
  const {
    internalContext,
    agentSystemPrompt,
    agentId,
    demand,
    decision,
    history,
    pmInnovationConfig,
  } = params;
  const effectiveSystemPrompt =
    canonicalAgentKey(agentId) === 'product_manager'
      ? (applyPmInnovationToProductManager(
          { system_prompt: agentSystemPrompt } as AgentPromptConfig,
          demand,
          pmInnovationConfig,
        )?.system_prompt ?? agentSystemPrompt)
      : agentSystemPrompt;
  const moveInstructions: Record<ModeratorDecision['dialogue_move'], string> = {
    open: 'Apresente a demanda reformulada e levante os pontos principais para discussão.',
    question: 'Faça perguntas específicas para esclarecer pontos importantes.',
    answer: `Responda à pergunta ou ponto levantado${decision.is_reply_to ? ` por ${decision.is_reply_to}` : ''}.`,
    challenge: 'Apresente uma visão diferente ou questione uma premissa da discussão.',
    support: 'Complemente ou reforce pontos já levantados com sua perspectiva.',
    synthesize: 'Resuma os pontos de consenso e as divergências identificadas.',
    close: 'Sintetize a discussão e apresente a conclusão da mesa redonda.',
  };
  const dialogueInstruction = moveInstructions[decision.dialogue_move];
  const replyContext = decision.is_reply_to
    ? `Você está RESPONDENDO DIRETAMENTE a ${decision.is_reply_to}. `
    : '';
  const historyBlock =
    history.length > 0
      ? `\n\n--- DIÁLOGO ATÉ AGORA ---\n${history.slice(-8).join('\n\n')}\n--- FIM DO DIÁLOGO ---\n`
      : '';
  const systemPrompt = `${internalContext}\n\n${effectiveSystemPrompt}\n\n[MESA REDONDA — DIÁLOGO DINÂMICO]\n${historyBlock}

${replyContext}${dialogueInstruction}

IMPORTANTE:
- Responda APENAS com JSON válido
- Seja CONCISO (máx 150 palavras no content)
- Adicione o que SOMENTE VOCÊ (${agentId}) pode contribuir — se outro agente já cobriu um ponto, cite-o em 1 frase e avance
- Se discordar, seja construtivo e específico sobre o que diverge
- REGRA DE INTEGRIDADE NUMÉRICA: NUNCA invente números ou prazos. Se citar algum número (percentual, monetário, ROI, prazo de dias/semanas), você DEVE preencher o campo "evidence_for_numbers" com a fonte desse número no input ou nas evidências reais do repositório. Caso contrário, use sempre 'A MEDIR — sem baseline'.

Formato JSON:
{
  "type": "response" | "divergence" | "question",
  "content": "sua contribuição",
  "response_to": "${decision.is_reply_to || ''}" (se aplicável),
  "references": ["arquivo1.ts"] (se aplicável),
  "evidence_for_numbers": "fonte do número citado ou vazio se não houver número"
}`;
  const userPrompt = `Demanda: ${demand.title}\n${demand.description}\n\nContribua como ${agentId}. Movimento: ${decision.dialogue_move}. Razão: ${decision.reason}`;
  return { systemPrompt, userPrompt };
}

export function buildModeratorSystemPrompt(
  agents: string[],
  history: string[],
  availableExtraAgents?: Record<string, string>,
): string {
  const hasExtraAgents = Boolean(
    availableExtraAgents && Object.keys(availableExtraAgents).length > 0,
  );
  const escalationSection = hasExtraAgents
    ? `\nESPECIALISTAS DISPONÍVEIS MAS NÃO NA SQUAD ATUAL (chave: capacidade):\n${Object.entries(
        availableExtraAgents as Record<string, string>,
      )
        .map(([key, description]) => `- ${key}: ${description}`)
        .join(
          '\n',
        )}\nSe a discussão revelar uma necessidade CONCRETA e específica que nenhum dos AGENTES DISPONÍVEIS cobre, preencha "escalate_agent" com a chave do especialista e "escalate_reason" com o motivo curto. NÃO escale por rotina — só quando for claramente necessário.\n`
    : '';
  const escalationFields = hasExtraAgents
    ? `,\n  "escalate_agent": "chave_do_especialista (opcional, só se necessário)",\n  "escalate_reason": "motivo curto (opcional, obrigatório se escalate_agent vier preenchido)"`
    : '';

  return `Você é o moderador de uma mesa redonda de refinamento de produto.
Sua função é decidir QUEM deve falar AGORA para criar um diálogo natural e produtivo.

AGENTES DISPONÍVEIS: ${agents.join(', ')}
${escalationSection}
HISTÓRICO DA DISCUSSÃO:
${history.slice(-6).join('\n\n')}

REGRAS DE MODERAÇÃO:
1. Se alguém fez uma PERGUNTA (contém "?"), dê a palavra a quem pode responder
2. Se alguém MENCIONOU outro agente, dê chance de réplica
3. Se houve DIVERGÊNCIA, peça esclarecimento ou busque consenso
4. Se um agente ainda não falou, inclua-o na discussão
5. Evite que o mesmo agente fale 2x seguidas (exceto réplica direta)
6. Se já há consenso suficiente, sintetize e encerre

MOVIMENTOS DE DIÁLOGO:
- "question": Agente vai fazer uma pergunta
- "answer": Agente vai responder uma pergunta pendente
- "challenge": Agente vai questionar/divergir de algo dito
- "support": Agente vai concordar/complementar
- "synthesize": Agente vai resumir pontos-chave
- "close": Encerrar discussão (só PO)

Responda APENAS com JSON válido:
{
  "next_speaker": "nome_do_agente",
  "reason": "por que este agente deve falar agora",
  "is_reply_to": "nome_do_agente_anterior (opcional)",
  "dialogue_move": "question|answer|challenge|support|synthesize|close",
  "should_continue": true/false${escalationFields}
}`;
}

function compactHistory(history: string[], maxItems = 8): string[] {
  return history
    .map((item) =>
      item
        .replace(/^\[Turno \d+\]\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .slice(0, maxItems);
}

function pickHistoryItems(history: string[], pattern: RegExp, fallbackItems: string[]): string[] {
  const matches = compactHistory(history, 12)
    .filter((item) => pattern.test(item))
    .map((item) => item.slice(0, 320));

  return matches.length > 0 ? matches.slice(0, 5) : fallbackItems;
}

function buildFallbackConsolidation(
  demand: Demand,
  history: string[],
  rounds: RoundtableRoundResult[],
  divergenceCount: number,
): RefinementOutput {
  const highlights = compactHistory(history, 6);
  const scopeItems = pickHistoryItems(
    history,
    /escopo|scheduler|implementar|tela|monitoramento|job/i,
    [
      'Consolidar o escopo discutido pela mesa redonda e transformar os pontos aprovados em entrega verificavel.',
    ],
  );
  const acceptanceItems = pickHistoryItems(
    history,
    /criterio|crit[eé]rio|validar|teste|baseline|meta|sucesso|falha|status/i,
    [
      'Validar a entrega contra os criterios debatidos pelos agentes e registrar evidencias objetivas.',
    ],
  );
  const riskItems = pickHistoryItems(
    history,
    /risco|falha|bloque|rate limit|certificado|regulat[oó]rio/i,
    ['Revisar riscos operacionais, tecnicos e de dados antes da execucao.'],
  );
  const dependencyItems = pickHistoryItems(
    history,
    /depend[eê]ncia|lambda|cloudwatch|sqs|banco|logs|api/i,
    ['Confirmar dependencias tecnicas e fontes de dados citadas durante a mesa redonda.'],
  );
  const allDivergences = rounds.flatMap((round) => round.divergences).filter(Boolean);

  return {
    problema: demand.description,
    objetivo:
      highlights[0] ||
      `Consolidar a decisao de produto para "${demand.title}" com base na mesa redonda.`,
    escopo: scopeItems.map((item) => `- ${item}`).join('\n'),
    criterios_de_aceite: acceptanceItems,
    riscos: riskItems,
    dependencias: dependencyItems,
    divergencias: allDivergences,
    consolidacao:
      highlights.length > 0
        ? highlights.join('\n\n')
        : `Mesa redonda concluida com ${rounds.length} rodada(s) e ${divergenceCount} divergencia(s).`,
  };
}

function publishRoundtableAgentStarted(
  runtimeContext: RoundtableRuntimeContext | undefined,
  input: { demandId: number; agentName: string; turnIndex: number },
): void {
  if (!runtimeContext?.runId) return;
  eventBus.publish('AGENT_STARTED', {
    timestamp: new Date().toISOString(),
    runId: runtimeContext.runId,
    pipelineId: runtimeContext.pipelineId,
    demandId: input.demandId,
    agentName: input.agentName,
    turnIndex: input.turnIndex,
    status: 'started',
  });
}

function publishRoundtableAgentCompleted(
  runtimeContext: RoundtableRuntimeContext | undefined,
  input: { demandId: number; agentName: string; turnIndex: number; durationMs: number },
): void {
  if (!runtimeContext?.runId) return;
  eventBus.publish('AGENT_COMPLETED', {
    timestamp: new Date().toISOString(),
    runId: runtimeContext.runId,
    pipelineId: runtimeContext.pipelineId,
    demandId: input.demandId,
    agentName: input.agentName,
    turnIndex: input.turnIndex,
    status: 'completed',
    durationMs: input.durationMs,
  });
}

function publishRoundtableAgentFailed(
  runtimeContext: RoundtableRuntimeContext | undefined,
  input: {
    demandId: number;
    agentName: string;
    turnIndex: number;
    durationMs: number;
    error: string;
  },
): void {
  if (!runtimeContext?.runId) return;
  eventBus.publish('AGENT_FAILED', {
    timestamp: new Date().toISOString(),
    runId: runtimeContext.runId,
    pipelineId: runtimeContext.pipelineId,
    demandId: input.demandId,
    agentName: input.agentName,
    turnIndex: input.turnIndex,
    status: 'failed',
    durationMs: input.durationMs,
    error: input.error,
  });
}

function publishRoundtableDivergence(
  runtimeContext: RoundtableRuntimeContext | undefined,
  input: {
    demandId: number;
    agentName: string;
    turnIndex: number;
    round: number;
    content: string;
    dialogueMove?: string;
  },
): void {
  if (!runtimeContext?.runId) return;
  eventBus.publish('ROUNDTABLE_DIVERGENCE_RECORDED', {
    timestamp: new Date().toISOString(),
    runId: runtimeContext.runId,
    pipelineId: runtimeContext.pipelineId,
    demandId: input.demandId,
    agentName: input.agentName,
    turnIndex: input.turnIndex,
    round: input.round,
    content: input.content,
    dialogueMove: input.dialogueMove,
  });
}

export class RoundtableOrchestrator {
  private parent: AISquadService;

  constructor(parent: AISquadService) {
    this.parent = parent;
  }

  /**
   * Spec 10140: registra metadados de um turno para extração heurística de
   * padrões. Chamado por loops de agente e moderador.
   */
  private recordTurnMetadata(
    turnMetadata: RoundtableTurnMetadata[],
    turn: RoundtableTurnMetadata,
  ): void {
    turnMetadata.push(turn);
  }

  /**
   * Spec 10140: hook assíncrono de self-improvement. Roda em setImmediate
   * após o roundtable ser concluído; nunca aborta o fluxo principal.
   * O snapshot de turnMetadata é feito antes do setImmediate para evitar
   * race condition com outra execução concorrente do singleton.
   */
  private runSelfImprovementHook(
    demandId: number,
    result: RoundtableResult,
    turnMetadata: RoundtableTurnMetadata[],
    skipExtraction?: boolean,
  ): void {
    if (skipExtraction) return;

    const snapshot = [...turnMetadata];
    setImmediate(() => {
      try {
        const patterns = extractPatterns({
          demandId,
          agentsFailed: result.agentsFailed,
          totalDivergences: result.totalDivergences,
          rounds: result.rounds,
          consolidation: result.consolidation,
          turnMetadata: snapshot,
        });

        for (const pattern of patterns) {
          llmAuditLogService.recordSelfImprovementPattern(pattern);
        }

        logger.info('[RoundtableOrchestrator] Self-improvement hook completed', {
          context: { demandId, patternsCount: patterns.length },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn('[RoundtableOrchestrator] Self-improvement hook failed', {
          error: error instanceof Error ? error : undefined,
          context: { demandId },
        });
        llmAuditLogService.recordSelfImprovementPattern({
          agent_type: 'squad',
          roundtable_id: demandId,
          extracted_pattern: null,
          confidence_hint: 'low',
          extraction_error: errorMessage,
        });
      }
    });
  }

  /**
   * Demanda 10081 parte B: aplica (se válido) o escalonamento sugerido pelo
   * moderador — traz um agente que não estava na squad inicial para dentro
   * do run. `effectiveAgents` é a mesma referência lida pelo moderador a
   * cada turno (round-robin lê `.length` ao vivo; o prompt LLM lista
   * `agents.join(', ')` a cada chamada), então o novo agente já entra
   * disponível a partir do próximo turno — não precisa de nenhum "briefing"
   * especial, porque cada turno já reconstrói contexto só com os últimos 8
   * itens do histórico, igual a qualquer outro agente no seu Nº turno.
   *
   * Muta `effectiveAgents` e `escalations` in-place (mesmo padrão de
   * mutação já usado no arquivo, ex.: reorder do PO). Retorna o novo
   * `maxTurns`/`tokenBudgetLimit` quando aplica, ou `null` quando não há
   * escalonamento válido a aplicar (flag off, sem sugestão, agente já
   * presente/inexistente, ou teto de escalonamentos atingido).
   */
  private tryEscalateAgent(params: {
    demandId: number;
    decision: ModeratorDecision;
    effectiveAgents: string[];
    escalations: Array<{ agent: string; round: number; reason: string }>;
    maxDynamicEscalations: number;
    maxRounds: number;
    refinementLevel: RefinementLevel;
    currentRound: number;
  }): { maxTurns: number; tokenBudgetLimit: number } | null {
    const {
      demandId,
      decision,
      effectiveAgents,
      escalations,
      maxDynamicEscalations,
      maxRounds,
      refinementLevel,
      currentRound,
    } = params;

    if (!featureFlags.getFlags().enableDynamicAgentEscalation) return null;
    if (!decision.escalate_agent) return null;
    if (escalations.length >= maxDynamicEscalations) return null;
    if (effectiveAgents.includes(decision.escalate_agent)) return null;
    if (!this.parent.agentConfigs[decision.escalate_agent]) return null;

    const escalatedAgent = decision.escalate_agent;
    const reason = decision.escalate_reason?.trim() || 'Necessidade identificada pelo moderador';
    effectiveAgents.push(escalatedAgent);
    const maxTurns = calculateRoundtableMaxTurns(
      effectiveAgents.length,
      maxRounds,
      refinementLevel,
    );
    const tokenBudgetLimit = calculateRoundtableTokenBudget(maxTurns, refinementLevel);
    escalations.push({ agent: escalatedAgent, round: currentRound, reason });

    logger.info('[RoundtableOrchestrator] Agente escalado no meio do refinamento', {
      context: { demandId, agent: escalatedAgent, round: currentRound, reason },
    });
    sseManager.sendRoundtableEvent(demandId, 'roundtable_agent_joined', {
      agent: escalatedAgent,
      round: currentRound,
      reason,
    });

    return { maxTurns, tokenBudgetLimit };
  }

  /**
   * Moderador decide dinamicamente quem fala próximo baseado no contexto
   */
  private async decideNextSpeaker(
    demandId: number,
    demand: Demand,
    agents: string[],
    history: string[],
    turnCount: number,
    maxTurns: number,
    extraRoundsUsed = 0,
    refinementLevel: RefinementLevel = 3,
    turnMetadata: RoundtableTurnMetadata[] = [],
  ): Promise<ModeratorDecision & { forcedExtraRound?: boolean }> {
    // Primeira fala: sempre PO abre
    if (history.length === 0) {
      return {
        next_speaker: agents.includes('product_owner') ? 'product_owner' : agents[0],
        reason: 'PO abre a discussão apresentando a demanda',
        dialogue_move: 'open',
        should_continue: true,
      };
    }

    // Verificar se já temos falas suficientes
    if (turnCount >= maxTurns) {
      return {
        next_speaker: agents.includes('product_owner') ? 'product_owner' : agents[0],
        reason: 'Limite de turnos atingido, PO sintetiza',
        dialogue_move: 'close',
        should_continue: false,
      };
    }

    const flags = featureFlags.getFlags();
    const moderatorMode = flags.roundtableModeratorMode;
    if (!shouldUseLlmModerator(moderatorMode, refinementLevel)) {
      return {
        next_speaker: agents[turnCount % agents.length] || agents[0],
        reason: `Ordem determinística (${moderatorMode}, nível ${refinementLevel})`,
        dialogue_move: 'support',
        should_continue: turnCount < maxTurns - 1,
      };
    }

    // 4a: Limitar histórico do moderador aos últimos N turnos — decisão de
    // "quem fala" só precisa de contexto recente, não do histórico completo.
    const moderatorHistoryK = flags.moderatorMaxHistoryTurns ?? 3;
    const recentHistory = history.slice(-moderatorHistoryK);

    // Demanda 10081 parte B: só monta o catálogo de especialistas "de fora" (e
    // só menciona escalonamento no prompt) quando a flag está ligada — flag
    // off mantém o prompt byte-idêntico ao de antes desta demanda.
    let availableExtraAgents: Record<string, string> | undefined;
    if (flags.enableDynamicAgentEscalation) {
      const extras = Object.entries(this.parent.agentConfigs).filter(
        ([key]) => !agents.includes(key),
      );
      if (extras.length > 0) {
        availableExtraAgents = Object.fromEntries(
          extras.map(([key, config]) => [key, config.description || '(sem descrição)']),
        );
      }
    }
    const systemPrompt = buildModeratorSystemPrompt(agents, recentHistory, availableExtraAgents);
    const userPrompt = `Turno ${turnCount + 1}/${maxTurns}. Quem deve falar agora?`;

    // 1a/1e: Cache do moderador controlado por feature flag e TTL configurável
    const moderatorCacheEnabled = flags.enableRoundtableCache ?? false;
    const moderatorCacheTtlMs = flags.roundtableCacheModeratorTtlMs ?? 3_600_000;

    // ── Chamada base ao moderador (1 amostra) ──────────────────────────────────
    // P1-3: forSelfConsistency=true desabilita cache para garantir diversidade
    //        entre as N amostras do SC — se todas batessem no cache retornariam
    //        a mesma resposta e o voto majoritário ficaria trivialmente viciado.
    const callModerator = async (forSelfConsistency = false): Promise<ModeratorDecision> => {
      // 4c: maxTokens do moderador via flag.
      // Bug #10141: moderador precisa de 500 tokens pois deepseek-v4-flash-202605
      // consome ~156 tokens em reasoning_content, deixando ~344 para o JSON.
      const moderatorMaxTk = Math.max(flags.moderatorMaxTokens ?? 500, 500);

      // Resolve a política de cache usando a função pura compartilhada
      const cachePolicy = resolveRoundtableCachePolicy({
        enabled: moderatorCacheEnabled,
        forSelfConsistency,
        ttlMs: moderatorCacheTtlMs,
      });

      const moderatorStartedAt = Date.now();
      const completion = await openAIService.generateChatCompletionWithMetadata(
        systemPrompt,
        userPrompt,
        {
          demandId,
          temperature: 0.5, // temperatura > 0 para diversidade nas amostras SC
          maxTokens: moderatorMaxTk,
          taskType: 'json',
          responseFormat: 'json_object',
          operation: 'roundtable:moderator',
          failOpenOnError: true,
          // P0-1: exact-only — semântico desabilitado (JSON estruturado não deve bater em hits semânticos stale)
          semanticCacheDisabled: cachePolicy.semanticCacheDisabled,
          // 1a/1e: cache ativado por flag com TTL explícito; desabilitado em amostras SC
          cache: cachePolicy.cache,
          cacheTtlMs: cachePolicy.cacheTtlMs,
        },
      );

      // Spec 10140: captura metadados do moderador para self-improvement.
      this.recordTurnMetadata(turnMetadata, {
        agentId: 'moderator',
        modelUsed: completion.metadata?.modelUsed ?? 'unknown',
        durationMs: Date.now() - moderatorStartedAt,
        content: completion.content ?? '',
        parseFailed: false,
        retried: forSelfConsistency,
        round: turnCount + 1,
      });

      // 8a/8b: Emite métricas de custo e tokens do moderador
      // P0-2: só emitir se não foi cache hit (exact ou semântico) —
      //        hits não consumiram tokens reais do provedor
      if (completion.metadata) {
        if (!isCacheHit(completion.metadata)) {
          const pTokens = completion.metadata.promptTokens ?? 0;
          const cTokens = completion.metadata.completionTokens ?? 0;
          const cost = completion.metadata.costEstimate ?? 0;

          const agentName = completion.metadata.agentName ?? 'roundtable:moderator';
          const agentVersion = completion.metadata.agentVersion ?? 'unknown';
          roundtableTokensTotal
            .labels('moderator', 'input', String(refinementLevel), agentName, agentVersion)
            .inc(pTokens);
          roundtableTokensTotal
            .labels('moderator', 'output', String(refinementLevel), agentName, agentVersion)
            .inc(cTokens);
          roundtableCostUsdTotal
            .labels('moderator', String(refinementLevel), agentName, agentVersion)
            .inc(cost);
        } else {
          // P1-4: classificação correta usando a função pura compartilhada
          const cacheType = classifyCacheResult(completion.metadata);
          if (cacheType !== 'none') {
            roundtableCacheHitTotal.labels('moderator', cacheType).inc();
          }
        }
      }

      const parsed = ModeratorDecisionSchema.safeParse(
        extractJsonObject(completion.content || '{}'),
      );
      if (!parsed.success) throw new Error('Moderator JSON invalid');
      if (!agents.includes(parsed.data.next_speaker)) {
        parsed.data.next_speaker = agents[turnCount % agents.length];
      }
      return parsed.data;
    };

    try {
      // RF-A7: resolve o modelo que de fato será usado (mesmo taskType da chamada
      // do moderador) e desabilita SC se for um modelo 'reasoning'.
      const resolvedModel = resolveModel({ taskType: 'classification' });
      const isReasoningModel = getModelConfig(resolvedModel).behavior === 'reasoning';
      // B1: self-consistency só no subconjunto de ALTA CRITICIDADE. O custo extra
      // (N amostras por decisão do moderador) só se justifica onde o erro é mais
      // caro. `demand.priority` ('baixa'|'media'|'alta'|'critica') é o sinal de
      // criticidade do tipo Demand — mesma sinalização de prioridade usada pelo
      // classificador canônico em server/cognitive-core/demand-classifier.ts.
      const isHighRisk = demand.priority === 'alta' || demand.priority === 'critica';
      const scEnabled = flags.selfConsistencyEnabled && !isReasoningModel && isHighRisk;

      if (scEnabled) {
        // 6b: N=2 para nível 2, N=selfConsistencyN (default 3) para nível 3
        const defaultN = flags.selfConsistencyN ?? 3;
        const n = refinementLevel === 2 ? (flags.selfConsistencyNLevel2 ?? 2) : defaultN;
        const threshold = flags.selfConsistencyThreshold ?? 0.6;

        const scResult = await runWithSelfConsistency(
          // P1-3: passa forSelfConsistency=true para desabilitar cache em cada amostra
          () => callModerator(true),
          (d) => `${d.next_speaker}:${String(d.should_continue)}`,
          aggregateFirst,
          { n, label: `moderator:turn${turnCount}` },
        );

        logger.info('[RoundtableSC] Moderator decision', {
          context: {
            demandId,
            turn: turnCount,
            confidence: scResult.confidence,
            voteDistribution: scResult.voteDistribution,
            winner: `${scResult.winner.next_speaker}:${scResult.winner.should_continue}`,
          },
        });

        // RF-A5: confiança < limiar em decisão de encerramento → forçar rodada
        // extra, respeitando o teto cumulativo de rodadas extras já consumidas
        // (o contador é mantido pelo loop chamador via `extraRoundsUsed`).
        const maxExtra = flags.selfConsistencyMaxExtraRounds ?? 2;
        if (
          !scResult.winner.should_continue &&
          scResult.confidence < threshold &&
          extraRoundsUsed < maxExtra
        ) {
          logger.warn('[RoundtableSC] Low-confidence close — forcing extra round', {
            context: {
              demandId,
              turn: turnCount,
              confidence: scResult.confidence,
              extraRoundsUsed,
              maxExtra,
            },
          });
          return { ...scResult.winner, should_continue: true, forcedExtraRound: true };
        }

        return scResult.winner;
      }

      // SC desligada: comportamento original (1 amostra)
      return await callModerator(false);
    } catch (e) {
      logger.warn('[RoundtableOrchestrator] Moderator decision failed, using fallback', {
        error: e instanceof Error ? e : undefined,
      });
    }

    // Fallback: round-robin simples
    const lastSpeaker =
      history.length > 0 ? history[history.length - 1].match(/^\[.*?\] (\w+):/)?.[1] : null;
    const availableAgents = agents.filter((a) => a !== lastSpeaker);
    const nextAgent = availableAgents[turnCount % availableAgents.length] || agents[0];

    return {
      next_speaker: nextAgent,
      reason: 'Próximo na ordem de discussão',
      dialogue_move: 'support',
      should_continue: turnCount < maxTurns - 1,
    };
  }

  /**
   * Spec 10176: executa gate AppSec real sobre o prompt final pós-assembler.
   * Injeta `requireAppSecReview` no contexto para demandas security/infra.
   */
  public runAppSecGate(
    demand: Demand,
    internalContext: string,
    effectiveAgents: string[],
  ): AppSecGateResult {
    const demandTypeConfig = DEMAND_TYPES[demand.type as keyof typeof DEMAND_TYPES];
    const requireAppSecReview =
      demandTypeConfig?.constraints.requireAppSecReview === true ||
      (demand as { requireAppSecReview?: boolean }).requireAppSecReview === true;

    // Só aplica o gate quando security_specialist está na squad efetiva ou
    // quando a flag explícita está ligada.
    const hasSecuritySpecialist = effectiveAgents.includes('security_specialist');
    const shouldRun = requireAppSecReview || hasSecuritySpecialist;

    return evaluateAppSecGate({
      demandId: demand.id,
      requireAppSecReview: shouldRun,
      promptText: internalContext,
      agentOrder: effectiveAgents,
    });
  }

  async runRoundTable(
    demandId: number,
    config: RoundtableConfig,
    internalContext: string,
    onProgress?: (message: ChatMessage) => void,
    runtimeContext?: RoundtableRuntimeContext,
  ): Promise<RoundtableResult> {
    // Spec 10140: coletor de metadados local por execução. Cada runRoundTable
    // tem seu próprio array, evitando race condition entre refinamentos
    // concorrentes no singleton RoundtableOrchestrator.
    const turnMetadata: RoundtableTurnMetadata[] = [];
    const roundtableStartedAt = Date.now();
    const demand = await demandRepository.findById(demandId);
    const { agentIds, maxRounds } = config;
    const refinementLevel = config.refinementLevel ?? 3;

    // Converter rodadas em turnos: mais turnos = diálogo mais rico
    const requestedAgents = agentIds.length > 0 ? agentIds : DEFAULT_ROUNDTABLE_AGENTS;
    const effectiveAgents = [...new Set(requestedAgents.map(canonicalAgentKey))].filter(
      (agentId) => {
        const hasConfig = Boolean(this.parent.agentConfigs[agentId]);
        if (!hasConfig) {
          logger.warn(`[RoundtableOrchestrator] Skipping agent without active config: ${agentId}`, {
            context: { demandId, agentId },
          });
        }
        return hasConfig;
      },
    );
    if (effectiveAgents.length === 0) {
      effectiveAgents.push(
        ...DEFAULT_ROUNDTABLE_AGENTS.filter((agentId) =>
          Boolean(this.parent.agentConfigs[agentId]),
        ),
      );
    }
    const productOwnerIndex = effectiveAgents.indexOf('product_owner');
    if (productOwnerIndex > 0) {
      effectiveAgents.unshift(...effectiveAgents.splice(productOwnerIndex, 1));
    }
    // `let`, não `const`: demanda 10081 parte B pode escalar um agente novo
    // no meio do run e precisa reajustar o teto de turnos/tokens proporcionalmente.
    let maxTurns = calculateRoundtableMaxTurns(effectiveAgents.length, maxRounds, refinementLevel);

    // Slice 5: modela a mesa como um nó de deliberação no grafo, atrás de flag
    // (default off). Read-only — não toca o laço de diálogo nem a consolidação.
    let deliberationGraph: SquadGraph | undefined;
    try {
      if (featureFlags.getFlags().squadGraphEnabled === true) {
        deliberationGraph = buildDeliberationGraph(effectiveAgents);
        logger.info('Roundtable: grafo de deliberação construído', {
          context: {
            demandId,
            participants: effectiveAgents.length,
            nodes: deliberationGraph.nodes.length,
            edges: deliberationGraph.edges.length,
          },
        });
      }
    } catch (error) {
      logger.warn('Roundtable: falha ao construir grafo de deliberação — seguindo sem grafo', {
        error: error instanceof Error ? error : undefined,
        context: { demandId },
      });
      deliberationGraph = undefined;
    }

    const rounds: RoundtableRoundResult[] = [];
    const accumulatedHistory: string[] = [];
    const agentsFailed: string[] = [];
    let totalDivergences = 0;
    let tokensUsed = 0;
    // `let` pela mesma razão de `maxTurns` acima.
    let TOKEN_BUDGET_LIMIT = calculateRoundtableTokenBudget(maxTurns, refinementLevel);
    // Demanda 10081 parte B: registro dos agentes acionados no meio do run.
    const escalations: Array<{ agent: string; round: number; reason: string }> = [];
    const MAX_DYNAMIC_ESCALATIONS = 2;

    let turnCount = 0;
    let shouldContinue = true;
    let extraRoundsUsed = 0; // RF-A5: rodadas extras já forçadas por baixa confiança
    let currentRound = 1;
    let roundContributions: Record<string, string> = {};
    let roundDivergences: string[] = [];

    sseManager.sendRoundtableEvent(demandId, 'roundtable_round_start', {
      round: 1,
      totalRounds: Math.ceil(maxTurns / effectiveAgents.length),
      agents: effectiveAgents,
    });

    if (onProgress) {
      onProgress({
        id: `${demandId}-rt-dialogue-start`,
        agent: 'coordinator',
        message: `💬 Mesa redonda iniciada — até ${maxTurns} falas entre ${effectiveAgents.length} agentes`,
        timestamp: new Date().toISOString(),
        type: 'processing',
        progress: 10,
      });
    }

    // Loop de diálogo dinâmico (não round-robin fixo)
    const accumulatedChatMessages: ChatMessage[] = [];
    type PrefetchedTurn = {
      completion: Awaited<ReturnType<typeof openAIService.generateChatCompletionWithMetadata>>;
      durationMs: number;
    };
    const prefetchedTurns = new Map<string, PrefetchedTurn>();
    let parallelBatchInitialized = false;

    const saveAccumulatedChatMessages = async () => {
      if (accumulatedChatMessages.length === 0) return;

      try {
        const currentDemand = await demandRepository.findByIdOrNull(demandId);
        const currentMessages = currentDemand?.chatMessages || [];
        await demandRepository.updateChat(demandId, [
          ...currentMessages,
          ...accumulatedChatMessages,
        ]);
        accumulatedChatMessages.length = 0;
      } catch (err) {
        logger.error('[RoundtableOrchestrator] Failed to save batch chat messages', {
          error: err instanceof Error ? err : undefined,
          context: { demandId, messageCount: accumulatedChatMessages.length },
        });
      }
    };

    const ensureNotStopped = async () => {
      if (!this.parent.isStopRequested(demandId)) return;

      await saveAccumulatedChatMessages();
      await demandRepository.updateStatus(demandId, 'stopped');
      throw new Error('Execution stopped by user');
    };

    while (shouldContinue && turnCount < maxTurns && tokensUsed < TOKEN_BUDGET_LIMIT) {
      const turnStartedAt = Date.now();
      await ensureNotStopped();

      const activeFlags = featureFlags.getFlags();
      if (
        shouldRunParallelFirstCycle({
          enabled: activeFlags.enableParallelAgents,
          initialized: parallelBatchInitialized,
          turnCount,
          refinementLevel,
        })
      ) {
        parallelBatchInitialized = true;
        const historySnapshot = [...accumulatedHistory];
        const candidates = selectParallelFirstCycleAgents(effectiveAgents, maxTurns).filter(
          (candidate) => Boolean(this.parent.agentConfigs[candidate]),
        );
        const concurrency = activeFlags.roundtableParallelConcurrency;
        const results = await mapWithConcurrency(candidates, concurrency, async (candidate) => {
          const startedAt = Date.now();
          const candidateConfig = this.parent.agentConfigs[candidate];
          const candidateDecision: ModeratorDecision = {
            next_speaker: candidate,
            reason: 'Contribuição independente do primeiro ciclo paralelo',
            dialogue_move: 'support',
            should_continue: true,
          };
          try {
            const prompts = buildAgentTurnPrompts({
              internalContext,
              agentSystemPrompt: candidateConfig.system_prompt,
              agentId: candidate,
              demand,
              decision: candidateDecision,
              history: historySnapshot,
              pmInnovationConfig: this.parent.agentConfigs[PM_INNOVATION_AGENT_KEY],
            });
            const completion = await openAIService.generateChatCompletionWithMetadata(
              prompts.systemPrompt,
              prompts.userPrompt,
              {
                demandId,
                temperature: 0.7,
                maxTokens: calculateRoundtableMaxTokensPerTurn(refinementLevel),
                model: candidateConfig.model,
                modelFallback: candidateConfig.model_fallback,
                agentName: candidate,
                taskType: 'analysis',
                operation: `roundtable:${candidate}:parallel-first-cycle`,
                cache: false,
                failOpenOnError: true,
                // Bug #10224: mesmo motivo do completionOptions principal — ver comentário lá.
                skipInjectionCheck: true,
              },
            );
            const durationMs = Date.now() - startedAt;
            AgentMessageSchema.parse(extractJsonObject(completion.content || ''));
            // Spec 10140: registra metadados do turno paralelo bem-sucedido.
            this.recordTurnMetadata(turnMetadata, {
              agentId: candidate,
              modelUsed: completion.metadata?.modelUsed ?? 'unknown',
              durationMs,
              content: completion.content ?? '',
              parseFailed: false,
              retried: false,
              round: currentRound,
            });
            return {
              candidate,
              result: { completion, durationMs },
              error: null,
            };
          } catch (error) {
            // Spec 10140: registra metadados do turno paralelo que falhou.
            this.recordTurnMetadata(turnMetadata, {
              agentId: candidate,
              modelUsed: 'unknown',
              durationMs: Date.now() - startedAt,
              content: '',
              parseFailed: true,
              retried: false,
              round: currentRound,
              errorMessage: error instanceof Error ? error.message : String(error),
            });
            return {
              candidate,
              result: null,
              error: error instanceof Error ? error : new Error(String(error)),
            };
          }
        });

        for (const result of results) {
          if (result.result) {
            prefetchedTurns.set(result.candidate, result.result);
            roundtableExecutionMode.labels('parallel', String(refinementLevel), 'success').inc();
          } else {
            roundtableExecutionMode.labels('parallel', String(refinementLevel), 'fallback').inc();
            logger.warn('Parallel roundtable prefetch failed; sequential fallback will be used', {
              error: result.error ?? undefined,
              context: { demandId, agentId: result.candidate },
            });
          }
        }
      }

      // Moderador decide quem fala
      const moderatorStartedAt = Date.now();
      const decision = await this.decideNextSpeaker(
        demandId,
        demand,
        effectiveAgents,
        accumulatedHistory,
        turnCount,
        maxTurns,
        extraRoundsUsed,
        refinementLevel,
        turnMetadata,
      );
      const moderatorMode = shouldUseLlmModerator(
        featureFlags.getFlags().roundtableModeratorMode,
        refinementLevel,
      )
        ? 'llm'
        : 'round-robin';
      roundtableModeratorDuration
        .labels(moderatorMode, String(refinementLevel))
        .observe((Date.now() - moderatorStartedAt) / 1000);

      if (decision.forcedExtraRound) extraRoundsUsed += 1;

      // Demanda 10081 parte B: aplica o escalonamento sugerido pelo moderador,
      // se houver, válido e dentro do teto.
      const escalationResult = this.tryEscalateAgent({
        demandId,
        decision,
        effectiveAgents,
        escalations,
        maxDynamicEscalations: MAX_DYNAMIC_ESCALATIONS,
        maxRounds,
        refinementLevel,
        currentRound,
      });
      if (escalationResult) {
        maxTurns = escalationResult.maxTurns;
        TOKEN_BUDGET_LIMIT = escalationResult.tokenBudgetLimit;
      }

      const agentId = decision.next_speaker;
      const agentConfig = this.parent.agentConfigs[agentId];

      if (!agentConfig) {
        logger.warn(`[RoundtableOrchestrator] Agent config not found: ${agentId}`, {
          context: { demandId, agentId },
        });
        if (!agentsFailed.includes(agentId)) agentsFailed.push(agentId);
        turnCount++;
        continue;
      }

      sseManager.sendRoundtableEvent(demandId, 'roundtable_agent_start', {
        agent: agentId,
        round: currentRound,
        dialogue_move: decision.dialogue_move,
        reply_to: decision.is_reply_to,
      });

      const currentTurnIndex = turnCount;
      const agentTurnStartedAt = Date.now();
      let agentTurnSucceeded = false;
      const prefetchedTurn = prefetchedTurns.get(agentId);
      prefetchedTurns.delete(agentId);
      const streamingEnabled = featureFlags.getFlags().enableRoundtableStreaming && !prefetchedTurn;
      publishRoundtableAgentStarted(runtimeContext, {
        demandId,
        agentName: agentId,
        turnIndex: currentTurnIndex,
      });

      // Spec 10140: variáveis para captura de metadados do turno.
      let turnCompletion: Awaited<
        ReturnType<typeof openAIService.generateChatCompletionWithMetadata>
      > | null = null;
      let turnParseFailed = false;
      let turnRetried = false;
      let turnErrorMessage: string | undefined;

      try {
        const { systemPrompt, userPrompt } = buildAgentTurnPrompts({
          internalContext,
          agentSystemPrompt: agentConfig.system_prompt,
          agentId,
          demand,
          decision,
          history: accumulatedHistory,
          pmInnovationConfig: this.parent.agentConfigs[PM_INNOVATION_AGENT_KEY],
        });

        const completionOptions = {
          demandId,
          temperature: 0.7,
          maxTokens: calculateRoundtableMaxTokensPerTurn(refinementLevel),
          model: agentConfig.model,
          modelFallback: agentConfig.model_fallback,
          agentName: agentId,
          taskType: 'analysis' as const,
          operation: `roundtable:${agentId}:turn${turnCount + 1}`,
          cache: false as const,
          failOpenOnError: true as const,
          // Bug #10224: userPrompt embute a demanda (já ingerida) a cada turno;
          // um doc anexado pode legitimamente citar um exemplo de prompt
          // injection sem ser um ataque real. Fluxo interno da squad — não é
          // input humano ao vivo. PII masking e fail-closed continuam ativos.
          skipInjectionCheck: true as const,
        };

        let completion;
        if (prefetchedTurn) {
          completion = prefetchedTurn.completion;
          turnCompletion = completion;
        } else if (streamingEnabled) {
          let pendingChunk = '';
          let lastEmissionAt = Date.now();
          let firstChunkObserved = false;
          const flushChunks = () => {
            if (!pendingChunk) return;
            sseManager.sendRoundtableEvent(demandId, 'roundtable_agent_token', {
              agent: agentId,
              round: currentRound,
              chunk: pendingChunk,
            });
            pendingChunk = '';
            lastEmissionAt = Date.now();
          };
          completion = await openAIService.generateChatCompletionStreamingWithMetadata(
            systemPrompt,
            userPrompt,
            {
              ...completionOptions,
              onChunk: (chunk: string) => {
                pendingChunk += chunk;
                if (pendingChunk.length >= 400 || Date.now() - lastEmissionAt >= 100) {
                  flushChunks();
                }
              },
              onFirstChunk: () => {
                if (firstChunkObserved) return;
                firstChunkObserved = true;
                roundtableTtft
                  .labels(agentId, String(refinementLevel))
                  .observe((Date.now() - agentTurnStartedAt) / 1000);
              },
              onStreamEnd: flushChunks,
            },
          );
          flushChunks();
          turnCompletion = completion;
        } else {
          completion = await openAIService.generateChatCompletionWithMetadata(
            systemPrompt,
            userPrompt,
            completionOptions,
          );
          turnCompletion = completion;
        }

        await ensureNotStopped();

        const rawResponse = completion.content || '';
        tokensUsed += rawResponse.length / 4;

        let parsedResponse: AgentMessage;
        try {
          const parsed = await parseAgentMessageWithRetry(rawResponse, async (validationError) => {
            logger.warn(
              `[RoundtableOrchestrator] Invalid structured response from agent ${agentId}; retrying once`,
              {
                error: validationError,
                context: {
                  demandId,
                  agentId,
                  turn: turnCount + 1,
                  rawResponseLength: rawResponse.length,
                  emptyResponse: rawResponse.trim().length === 0,
                  event: 'roundtable_structured_output_retry',
                },
              },
            );

            turnRetried = true;
            const retryCompletion = await openAIService.generateChatCompletionWithMetadata(
              `${systemPrompt}\n\n[CORREÇÃO DE FORMATO] A resposta anterior foi vazia ou inválida. Gere novamente a contribuição e responda SOMENTE com um objeto JSON válido no formato solicitado, sem markdown ou texto adicional.`,
              userPrompt,
              {
                ...completionOptions,
                temperature: 0,
                operation: `${completionOptions.operation}:structured-retry`,
              },
            );
            await ensureNotStopped();
            const retryRawResponse = retryCompletion.content || '';
            tokensUsed += retryRawResponse.length / 4;
            return retryRawResponse;
          });
          parsedResponse = parsed.message;
        } catch (e: unknown) {
          logger.warn(`[RoundtableOrchestrator] Invalid JSON from agent ${agentId} after retry`, {
            error: e instanceof Error ? e : new Error(String(e)),
            context: {
              demandId,
              agentId,
              turn: turnCount + 1,
              rawResponseLength: rawResponse.length,
              emptyResponse: rawResponse.trim().length === 0,
            },
          });
          throw e;
        }

        const responseTo = parsedResponse.response_to || decision.is_reply_to;
        const msgType = parsedResponse.type;
        let content = parsedResponse.content;
        const references = parsedResponse.references;

        // B3. Validação leve no loop de números sem evidence_for_numbers (ignora aspas)
        const contentForValidation = content
          .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '')
          .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, '');

        const hasNumbers =
          /\b\d+%/g.test(contentForValidation) ||
          /\$\s?\d/g.test(contentForValidation) ||
          /R\$\s?\d/g.test(contentForValidation) ||
          /\b\d+:\d+\b/g.test(contentForValidation) ||
          /\b\d+\s*(?:dia|semana|dias|semanas|h|mês|mêses|mes|meses)\b/gi.test(
            contentForValidation,
          );

        if (hasNumbers && !parsedResponse.evidence_for_numbers) {
          logger.info('Membro da mesa redonda citou número sem preencher evidence_for_numbers', {
            context: {
              event: 'numeric_unsourced_by_agent',
              agentId,
              turn: turnCount + 1,
              contentSnippet: content.slice(0, 100),
            },
          });
          // Sem evidência declarada: remover números não-ancorados na demanda antes de
          // exibir/persistir. Se o agente tivesse preenchido evidence_for_numbers, mantemos.
          content = NumericIntegrityValidator.validate(
            content,
            demand,
            [],
            'mesa redonda',
            'mark',
          ).cleanPrd;
        }

        // Formatar como diálogo natural
        const dialoguePrefix = responseTo ? `@${responseTo}: ` : '';
        const formattedContent = `${dialoguePrefix}${content}`;

        sseManager.sendRoundtableEvent(demandId, 'roundtable_agent_message', {
          agent_id: agentId,
          round: currentRound,
          response_to: responseTo,
          type: msgType,
          content: formattedContent,
          references: references,
          dialogue_move: decision.dialogue_move,
        });

        roundContributions[agentId] = (roundContributions[agentId] || '') + '\n' + content;
        accumulatedHistory.push(
          `[Turno ${turnCount + 1}] ${agentId}${responseTo ? ` → ${responseTo}` : ''}:\n${content}`,
        );

        const hasDivergence = msgType === 'divergence';
        if (hasDivergence) {
          roundDivergences.push(`[${agentId}] ${content}`);
          totalDivergences++;
          publishRoundtableDivergence(runtimeContext, {
            demandId,
            agentName: agentId,
            turnIndex: currentTurnIndex,
            round: currentRound,
            content,
            dialogueMove: decision.dialogue_move,
          });
          sseManager.sendRoundtableEvent(demandId, 'roundtable_divergence', {
            agent: agentId,
            round: currentRound,
            text: content,
          });
        }

        sseManager.sendRoundtableEvent(demandId, 'roundtable_agent_done', {
          agent: agentId,
          round: currentRound,
          hasDivergence,
          dialogue_move: decision.dialogue_move,
        });

        const progressValue = 10 + Math.round((turnCount / maxTurns) * 70);

        const chatMessageObj = {
          id: `${demandId}-rt-${agentId}-t${turnCount + 1}`,
          agent: agentId,
          message: formattedContent,
          timestamp: new Date().toISOString(),
          type: 'completed' as const,
          progress: progressValue,
          metadata: {
            roundtable: {
              turn: turnCount + 1,
              round: currentRound,
              hasDivergence,
              responseTo,
              msgType,
              dialogueMove: decision.dialogue_move,
              references,
            },
          },
        };

        if (onProgress) {
          onProgress(chatMessageObj);
        }

        // Accumulate in memory instead of saving to DB on every turn (Performance Fix T4)
        accumulatedChatMessages.push(chatMessageObj);

        // Verificar se devemos continuar
        shouldContinue = decision.should_continue && decision.dialogue_move !== 'close';

        // Agrupar em "rodadas" para compatibilidade
        if ((turnCount + 1) % effectiveAgents.length === 0) {
          rounds.push({
            round: currentRound,
            contributions: { ...roundContributions },
            divergences: [...roundDivergences],
          });
          currentRound++;
          roundContributions = {};
          roundDivergences = [];
        }
        publishRoundtableAgentCompleted(runtimeContext, {
          demandId,
          agentName: agentId,
          turnIndex: currentTurnIndex,
          durationMs: Date.now() - agentTurnStartedAt,
        });
        agentTurnSucceeded = true;
      } catch (err) {
        if (err instanceof Error && err.message === 'Execution stopped by user') {
          throw err;
        }

        const errMsg = err instanceof Error ? err.message : 'unknown error';
        turnParseFailed = true;
        turnErrorMessage = errMsg;
        logger.error(`[RoundtableOrchestrator] Agent ${agentId} failed at turn ${turnCount + 1}`, {
          error: err instanceof Error ? err : undefined,
          context: { demandId, agentId, turnCount },
        });
        publishRoundtableAgentFailed(runtimeContext, {
          demandId,
          agentName: agentId,
          turnIndex: currentTurnIndex,
          durationMs: Date.now() - agentTurnStartedAt,
          error: errMsg,
        });
        if (!agentsFailed.includes(agentId)) agentsFailed.push(agentId);
        sseManager.sendRoundtableEvent(demandId, 'agent_failed', {
          agent: agentId,
          reason: errMsg,
          round: currentRound,
        });
      } finally {
        // Spec 10140: registra metadados do turno após sucesso ou falha.
        if (turnCompletion || turnParseFailed) {
          this.recordTurnMetadata(turnMetadata, {
            agentId,
            modelUsed: turnCompletion?.metadata?.modelUsed ?? 'unknown',
            durationMs: Date.now() - agentTurnStartedAt,
            content: turnCompletion?.content ?? '',
            parseFailed: turnParseFailed,
            retried: turnRetried,
            round: currentRound,
            errorMessage: turnErrorMessage,
          });
        }
      }

      roundtableAgentDuration
        .labels(
          agentId,
          String(refinementLevel),
          prefetchedTurn ? 'parallel' : streamingEnabled ? 'streaming' : 'non-streaming',
        )
        .observe((prefetchedTurn?.durationMs ?? Date.now() - agentTurnStartedAt) / 1000);
      if (!prefetchedTurn) {
        roundtableExecutionMode
          .labels('sequential', String(refinementLevel), agentTurnSucceeded ? 'success' : 'failure')
          .inc();
      }
      roundtableTurnDuration
        .labels(String(refinementLevel))
        .observe((Date.now() - turnStartedAt) / 1000);
      turnCount++;
    }

    // Save all accumulated chat messages in a single DB operation
    await saveAccumulatedChatMessages();

    // Adicionar última rodada se tiver contribuições pendentes
    if (Object.keys(roundContributions).length > 0) {
      rounds.push({
        round: currentRound,
        contributions: roundContributions,
        divergences: roundDivergences,
      });
    }

    await ensureNotStopped();

    // Spec 10176: gate AppSec real antes da consolidação para security/infra.
    const appsecResult = this.runAppSecGate(demand, internalContext, effectiveAgents);
    if (appsecResult.status === 'blocked') {
      logger.warn('AppSec gate blocked consolidation', {
        context: {
          demandId,
          appsecStatus: appsecResult.status,
          appsecChecks: appsecResult.checks,
          reason: appsecResult.reason,
        },
      });
      throw new Error(`AppSec gate blocked: ${appsecResult.reason}`);
    }

    // Fase de consolidação
    const consolidation = await this.consolidate(
      demand,
      accumulatedHistory,
      rounds,
      totalDivergences,
      onProgress,
      refinementLevel,
    );

    await ensureNotStopped();

    sseManager.sendRoundtableEvent(demandId, 'roundtable_complete', {
      totalRounds: rounds.length,
      divergences: totalDivergences,
      agentsFailed,
    });

    if (onProgress) {
      onProgress({
        id: `${demandId}-rt-complete`,
        agent: 'coordinator',
        message: `✅ Mesa Redonda concluída com ${turnCount} fala(s) em ${rounds.length} ciclo(s). ${totalDivergences} divergência(s) discutida(s).`,
        timestamp: new Date().toISOString(),
        type: 'completed',
        progress: 95,
      });
    }

    roundtableTurnsUsed.labels(String(refinementLevel)).observe(turnCount);
    roundtableTotalDuration
      .labels(String(refinementLevel))
      .observe((Date.now() - roundtableStartedAt) / 1000);

    const roundtableResult: RoundtableResult = {
      rounds,
      consolidation,
      totalDivergences,
      agentsFailed,
      graph: deliberationGraph,
      escalations,
    };

    // Spec 10140: dispara hook assíncrono de self-improvement após o resultado
    // estar completamente construído. Não usa await — não bloqueia o retorno.
    this.runSelfImprovementHook(
      demandId,
      roundtableResult,
      turnMetadata,
      runtimeContext?.skipExtraction,
    );

    return roundtableResult;
  }

  private async consolidate(
    demand: Demand,
    history: string[],
    rounds: RoundtableRoundResult[],
    divergenceCount: number,
    onProgress?: (message: ChatMessage) => void,
    refinementLevel: RefinementLevel = 3,
  ): Promise<RefinementOutput> {
    if (onProgress) {
      onProgress({
        id: `${demand.id}-rt-consolidation-start`,
        agent: 'coordinator',
        message: '🧠 Consolidando contribuições da mesa redonda...',
        timestamp: new Date().toISOString(),
        type: 'processing',
        progress: 90,
      });
    }

    const allDivergences = rounds.flatMap((r) => r.divergences);

    const realityConstraints = contextBuilder.getRealityConstraints(demand.id);
    const typeRequirements = realityConstraints?.typeRequirements;
    const systemPrompt = buildConsolidationSystemPrompt(typeRequirements);
    const userPrompt = buildConsolidationUserPrompt(
      demand.title,
      demand.description,
      history,
      allDivergences,
      typeRequirements,
    );

    const generateConsolidationContent = async (
      feedbackAnterior?: string,
      docAnterior?: string,
    ): Promise<string> => {
      let finalUserPrompt = userPrompt;
      if (feedbackAnterior && docAnterior) {
        finalUserPrompt = `${userPrompt}\n\n=== FEEDBACK DO RED-TEAM E JUÍZO (AUTO-CORREÇÃO) ===\nA consolidação anterior falhou nas validações do Red-Team (críticas de facticidade/consistência confirmadas). Por favor, corrija a consolidação anterior resolvendo os pontos abaixo:\n\n${feedbackAnterior}\n\n=== CONSOLIDAÇÃO ANTERIOR (A SER CORRIGIDA) ===\n${docAnterior}`;
      }

      const consolidationFlags = featureFlags.getFlags();
      const consolidationCacheEnabled = consolidationFlags.enableRoundtableCache ?? false;
      const consolidationCacheTtlMs =
        consolidationFlags.roundtableCacheConsolidationTtlMs ?? 86_400_000;

      // Resolve a política de cache usando a função pura compartilhada
      const cachePolicy = resolveRoundtableCachePolicy({
        enabled: consolidationCacheEnabled,
        forSelfConsistency: false,
        ttlMs: consolidationCacheTtlMs,
      });

      const completion = await openAIService.generateChatCompletionWithMetadata(
        systemPrompt,
        finalUserPrompt,
        {
          demandId: demand.id,
          temperature: 0.3,
          maxTokens: 4000,
          taskType: 'analysis',
          operation: 'roundtable:consolidation',
          failOpenOnError: true,
          // P0-1: exact-only — semântico desabilitado para evitar hits stale em grandes docs
          semanticCacheDisabled: cachePolicy.semanticCacheDisabled,
          // 1b/1e: cache da consolidação ativado por flag com TTL 24h
          cache: cachePolicy.cache,
          cacheTtlMs: cachePolicy.cacheTtlMs,
          // Bug #10224: userPrompt embute demanda + histórico completo da mesa
          // redonda (conteúdo já ingerido/gerado pela squad, não input humano
          // ao vivo).
          skipInjectionCheck: true,
        },
      );

      // 8a/8b: Métricas de custo e tokens da consolidação
      // P0-2: só emitir se não foi cache hit — hits não consumiram tokens reais
      if (completion.metadata) {
        if (!isCacheHit(completion.metadata)) {
          const cPTokens = completion.metadata.promptTokens ?? 0;
          const cCTokens = completion.metadata.completionTokens ?? 0;
          const cost = completion.metadata.costEstimate ?? 0;

          const agentName = completion.metadata.agentName ?? 'roundtable:consolidation';
          const agentVersion = completion.metadata.agentVersion ?? 'unknown';
          roundtableTokensTotal
            .labels('consolidation', 'input', String(refinementLevel), agentName, agentVersion)
            .inc(cPTokens);
          roundtableTokensTotal
            .labels('consolidation', 'output', String(refinementLevel), agentName, agentVersion)
            .inc(cCTokens);
          roundtableCostUsdTotal
            .labels('consolidation', String(refinementLevel), agentName, agentVersion)
            .inc(cost);
        } else {
          // P1-4: classificação correta usando a função pura compartilhada
          const cacheType = classifyCacheResult(completion.metadata);
          if (cacheType !== 'none') {
            roundtableCacheHitTotal.labels('consolidation', cacheType).inc();
          }
        }
      }

      return completion.content || '{}';
    };

    try {
      let currentRaw = await generateConsolidationContent();

      const flags = featureFlags.getFlags();
      const useRedTeam = shouldUseRedTeam(flags.redTeamEnabled ?? false, refinementLevel);

      if (useRedTeam) {
        let iteration = 0;
        const maxIterations = 2;
        let bestRaw = currentRaw;
        let bestFailuresCount = Infinity;
        let wasOscillated = false;
        let totalHighFailuresConfirmed = 0;
        let totalLowFailuresLogged = 0;
        let allConfirmedFailures: any[] = [];

        logger.info('[RoundtableOrchestrator] Iniciando validação adversarial do PO (Red-Team)', {
          context: { demandId: demand.id },
        });

        while (iteration < maxIterations) {
          // 1. Carregar prompt do PO em modo adversarial (A1)
          const redTeamPrompt = buildPoAdversaryPrompt();
          const redTeamUserPrompt = `Mesa Redonda (Histórico de Discussão):\n${history.join('\n\n')}\n\nConsolidação Candidata a ser Analisada:\n${currentRaw}`;

          let redTeamResponse = '';
          try {
            if (onProgress) {
              onProgress({
                id: `${demand.id}-rt-red-team-${iteration}`,
                agent: 'product_owner',
                message: `🔍 Product Owner (Red-Team PO) analisando a consolidação candidata (tentativa ${iteration + 1})...`,
                timestamp: new Date().toISOString(),
                type: 'processing',
                progress: 92,
              });
            }

            const redTeamCompletion = await openAIService.generateChatCompletionWithMetadata(
              redTeamPrompt,
              redTeamUserPrompt,
              {
                demandId: demand.id,
                temperature: 0.2,
                maxTokens: 4000,
                taskType: 'analysis',
                operation: 'roundtable:red_team',
                cache: false,
                // Bug #10224: redTeamUserPrompt embute o histórico completo da
                // mesa redonda (conteúdo já gerado pela squad).
                skipInjectionCheck: true,
              },
            );
            redTeamResponse = redTeamCompletion.content || '{}';
          } catch (err) {
            logger.warn(
              '[RoundtableOrchestrator] Falha ao chamar Red-Team PO, encerrando loop (graceful degradation)',
              {
                error: err instanceof Error ? err : undefined,
                context: { demandId: demand.id },
              },
            );
            break;
          }

          const redTeamParsed = extractJsonObject(redTeamResponse) as any;
          const falhasDetectadas: any[] = redTeamParsed.falhas || [];

          if (falhasDetectadas.length === 0) {
            logger.info(
              '[RoundtableOrchestrator] Red-Team PO não encontrou nenhuma falha. Consolidação aprovada.',
            );
            bestRaw = currentRaw;
            bestFailuresCount = 0;
            break;
          }

          // 2. Chamar o Juiz de Consenso para confirmar falhas e mitigar falsos positivos (A3)
          const judgeSystemPrompt = `Você é um Juiz de Qualidade de Produto imparcial e rigoroso.
Sua tarefa é analisar as críticas apontadas pelo Product Owner adversarial sobre uma Consolidação de produto e o histórico do debate original da squad.
Filtre e valide apenas as críticas que são REALMENTE procedentes e representam furos lógicos, factuais, números inventados sem base no debate, ou alucinações de arquivos/tecnologias que não foram mencionadas.
Rejeite falsos positivos (críticas subjetivas, exigências estéticas ou picuinhas irrelevantes).

Para cada falha confirmada, você deve repassar a severidade original indicada pelo PO (ALTA ou BAIXA).

Responda APENAS com um objeto JSON no formato:
{
  "falhas_confirmadas": [
    {
      "trecho": "trecho de texto sob suspeita",
      "tipo": "tipo de falha",
      "severidade": "ALTA" | "BAIXA",
      "sugestao": "sugestão de correção detalhada",
      "motivo": "Por que esta crítica é de fato válida e procede com base no debate original"
    }
  ]
}`;

          const judgeUserPrompt = `Histórico de Discussão da Mesa Redonda:\n${history.join('\n\n')}\n\nConsolidação Candidata:\n${currentRaw}\n\nFalhas Apontadas pelo PO Adversarial:\n${JSON.stringify(falhasDetectadas, null, 2)}`;

          // RF-A3: self-consistency no juiz red-team. Roda N amostras e confirma
          // cada falha (chave = trecho) só com maioria; severidade agregada por
          // voto majoritário categórico (empate → ALTA). SC desabilitada para
          // modelos 'reasoning' (RF-A7) e quando a flag está off.
          const judgeReasoning =
            getModelConfig(resolveModel({ taskType: 'analysis' })).behavior === 'reasoning';
          // B1: mesmo gate de alta criticidade do moderador (ver decideNextSpeaker).
          const judgeIsHighRisk = demand.priority === 'alta' || demand.priority === 'critica';
          const judgeScEnabled =
            (flags.selfConsistencyEnabled ?? false) && !judgeReasoning && judgeIsHighRisk;
          const judgeN = judgeScEnabled ? (flags.selfConsistencyN ?? 3) : 1;

          if (onProgress) {
            onProgress({
              id: `${demand.id}-rt-judge-${iteration}`,
              agent: 'coordinator',
              message: `⚖️ Juiz avaliando as ${falhasDetectadas.length} críticas do PO${judgeN > 1 ? ` (${judgeN} amostras)` : ''}...`,
              timestamp: new Date().toISOString(),
              type: 'processing',
              progress: 93,
            });
          }

          const callJudgeOnce = async (): Promise<any[]> => {
            const judgeCompletion = await openAIService.generateChatCompletionWithMetadata(
              judgeSystemPrompt,
              judgeUserPrompt,
              {
                demandId: demand.id,
                temperature: judgeScEnabled ? 0.4 : 0.1, // >0 para diversidade entre amostras
                maxTokens: 4000,
                taskType: 'analysis',
                operation: 'roundtable:red_team_judge',
                cache: false,
                // Bug #10224: judgeUserPrompt embute o histórico completo da
                // mesa redonda (conteúdo já gerado pela squad).
                skipInjectionCheck: true,
              },
            );
            const parsed = extractJsonObject(judgeCompletion.content || '{}') as any;
            return Array.isArray(parsed.falhas_confirmadas) ? parsed.falhas_confirmadas : [];
          };

          let falhasConfirmadas: any[];
          if (judgeScEnabled && judgeN > 1) {
            const settled = await Promise.allSettled(
              Array.from({ length: judgeN }, () => callJudgeOnce()),
            );
            const judgeSamples = settled
              .filter((s): s is PromiseFulfilledResult<any[]> => s.status === 'fulfilled')
              .map((s) => s.value);

            if (judgeSamples.length === 0) {
              logger.warn(
                '[RoundtableOrchestrator] Todas as amostras do Juiz falharam, encerrando loop (graceful degradation)',
                {
                  context: { demandId: demand.id },
                },
              );
              break;
            }

            const validN = judgeSamples.length;
            // Agrega votos por falha (chave normalizada pelo trecho)
            const byKey: Record<string, { votes: number; severities: string[]; sample: any }> = {};
            for (const sampleFailures of judgeSamples) {
              const seenInSample = new Set<string>();
              for (const f of sampleFailures) {
                const key = String(f?.trecho ?? '')
                  .trim()
                  .toLowerCase()
                  .slice(0, 160);
                if (!key || seenInSample.has(key)) continue; // não conta a mesma falha 2x na mesma amostra
                seenInSample.add(key);
                if (!byKey[key]) byKey[key] = { votes: 0, severities: [], sample: f };
                byKey[key].votes += 1;
                byKey[key].severities.push(String(f?.severidade ?? 'BAIXA'));
              }
            }

            falhasConfirmadas = Object.values(byKey)
              .filter((e) => e.votes > validN / 2) // confirma só com maioria
              .map((e) => ({ ...e.sample, severidade: aggregateMajoritySeverity(e.severities) }));

            logger.info('[RoundtableSC] red_team_judge aggregated', {
              context: {
                demandId: demand.id,
                n: validN,
                reportedFailures: falhasDetectadas.length,
                distinctCandidates: Object.keys(byKey).length,
                confirmedByMajority: falhasConfirmadas.length,
                voteDistribution: Object.fromEntries(
                  Object.entries(byKey).map(([k, v]) => [k.slice(0, 40), v.votes]),
                ),
              },
            });
          } else {
            // SC desligada: comportamento original (1 amostra)
            try {
              falhasConfirmadas = await callJudgeOnce();
            } catch (err) {
              logger.warn(
                '[RoundtableOrchestrator] Falha ao chamar Juiz, encerrando loop (graceful degradation)',
                {
                  error: err instanceof Error ? err : undefined,
                  context: { demandId: demand.id },
                },
              );
              break;
            }
          }

          allConfirmedFailures = falhasConfirmadas;

          // Separar severidade ALTA e BAIXA (A4c)
          const falhasAltas = falhasConfirmadas.filter((f) => f.severidade === 'ALTA');
          const falhasBaixas = falhasConfirmadas.filter((f) => f.severidade === 'BAIXA');

          totalHighFailuresConfirmed = falhasAltas.length;
          totalLowFailuresLogged += falhasBaixas.length;

          // Logar falhas de severidade BAIXA
          falhasBaixas.forEach((f) => {
            logger.info(
              `[RoundtableOrchestrator] Falha de severidade BAIXA confirmada (logada e ignorada para loop): ${f.descricao}`,
            );
          });

          // Se não houver falhas de severidade ALTA confirmadas, o loop para
          if (falhasAltas.length === 0) {
            logger.info(
              '[RoundtableOrchestrator] Nenhuma falha de severidade ALTA confirmada pelo Juiz. Consolidação aprovada.',
            );
            bestRaw = currentRaw;
            bestFailuresCount = 0;
            break;
          }

          // Aplicar a guarda keep best (A4d): pontuar pelo número de falhas altas confirmadas
          const failuresCount = falhasAltas.length;
          if (failuresCount < bestFailuresCount) {
            bestRaw = currentRaw;
            bestFailuresCount = failuresCount;
            logger.info(
              `[RoundtableOrchestrator] A versão da iteração melhorou a consolidação (falhas altas: ${bestFailuresCount}).`,
            );
          } else {
            wasOscillated = true;
            logger.info(
              `[RoundtableOrchestrator] A versão da iteração anterior foi melhor ou igual (falhas altas: ${bestFailuresCount} vs atual: ${failuresCount}). Mantendo melhor anterior.`,
            );
          }

          iteration++;

          logger.info(
            `[RoundtableOrchestrator] Iniciando iteração de autocorreção ${iteration}/${maxIterations}`,
            {
              context: { demandId: demand.id, failuresCount },
            },
          );

          const feedbackAnterior = `Falhas de severidade ALTA confirmadas pelo Juiz que DEVEM ser corrigidas:\n${falhasAltas.map((f, i) => `${i + 1}. [${f.tipo.toUpperCase()}] No trecho: "${f.trecho}". Correção: ${f.sugestao} (Motivo: ${f.motivo})`).join('\n')}`;

          try {
            currentRaw = await generateConsolidationContent(feedbackAnterior, currentRaw);
          } catch (err) {
            logger.error(
              '[RoundtableOrchestrator] Erro ao regenerar consolidação no Reflexion loop',
              {
                error: err instanceof Error ? err : undefined,
                context: { demandId: demand.id },
              },
            );
            break;
          }
        }

        currentRaw = bestRaw;

        // Telemetria do Passo Zero e A7
        logger.info('PRD/TSD consolidation red-team metrics', {
          context: {
            demandId: demand.id,
            hasHighSeverityFailures: totalHighFailuresConfirmed > 0,
            iterationsExecuted: iteration,
            highFailuresCount: totalHighFailuresConfirmed,
            lowFailuresCount: totalLowFailuresLogged,
            failuresList: allConfirmedFailures.map((f) => ({
              tipo: f.tipo,
              severidade: f.severidade,
            })),
            wasOscillated: wasOscillated,
          },
        });
      }

      const parsed = extractJsonObject(currentRaw);
      const consolidation = RefinementOutputSchema.parse(parsed);

      // TODO(#audit-typeRequirements): auditar outros consumidores de typeRequirements
      // (ex.: DocumentGenerator, artifact-adapter) para garantir que as secoes obrigatorias
      // do tipo de demanda estejam sempre presentes no artifact final.
      this.validateTypeRequirementsInConsolidation(
        demand.id,
        demand.type,
        consolidation,
        realityConstraints?.typeRequirements,
      );

      return consolidation;
    } catch (err) {
      logger.warn('[RoundtableOrchestrator] Consolidation parse failed, using fallback', {
        error: err instanceof Error ? err : undefined,
        context: { demandId: demand.id },
      });
      return buildFallbackConsolidation(demand, history, rounds, divergenceCount);
    }
  }

  /**
   * Valida que as secoes obrigatorias do tipo de demanda aparecem no artifact
   * consolidado. Nao quebra a geracao: emite warning com a lista de secoes
   * ausentes e incrementa `consolidationTypeRequirementsMissingTotal` (spec
   * A-2 da avaliação de fluxo de agentes, 2026-07-26) — antes disso, o
   * warning só existia em log, sem contador, e ninguém percebia handoffs
   * incompletos sem procurar manualmente.
   */
  private validateTypeRequirementsInConsolidation(
    demandId: number,
    demandType: string,
    consolidation: RefinementOutput,
    typeRequirements: string[] | undefined,
  ): void {
    if (!typeRequirements || typeRequirements.length === 0) return;

    const text = [
      consolidation.problema,
      consolidation.objetivo,
      consolidation.escopo,
      consolidation.consolidacao,
      ...consolidation.criterios_de_aceite,
      ...consolidation.riscos,
      ...consolidation.dependencias,
      ...consolidation.divergencias,
    ]
      .join('\n')
      .toLowerCase();

    const missing = typeRequirements.filter((req) => {
      const normalized = req.toLowerCase().trim();
      return normalized && !text.includes(normalized);
    });

    if (missing.length > 0) {
      consolidationTypeRequirementsMissingTotal.labels(demandType).inc();
      logger.warn('[RoundtableOrchestrator] Consolidacao nao cobre secoes obrigatorias do tipo', {
        context: {
          demandId,
          demandType,
          missingSections: missing,
          typeRequirements,
        },
      });
    }
  }
}
