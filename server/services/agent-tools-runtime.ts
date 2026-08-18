/**
 * Agent Tools Runtime
 *
 * Runtime genérico para execução de tools em qualquer agente.
 */
import { getOpenRouterClient, resetOpenRouterClientCache } from './openrouter-client';
import { logger } from '../utils/logger';
import {
  GUARDRAIL_UNAVAILABLE_MESSAGE,
  runGuardrailsOnMessagesAsync,
  shouldFailClosed,
} from './llm-guardrails';
import { getToolsForOpenAI, type ToolResult } from './agent-tools-registry';
import {
  processToolsIteration,
  initializeToolsRuntime,
  checkToolsEnabled,
} from './agent-tools-runtime-utils';

// ============================================================
// Tipos
// ============================================================

export interface AgentToolsRuntimeInput {
  systemPrompt: string;
  userPrompt: string;
  agentName: string;
  model?: string;
  modelFallback?: string;
  temperature?: number;
  maxTokens?: number;
  maxSteps?: number;
  demandId?: number;
  orchestrationRunId?: string;
  orchestrationTurnId?: string;
  orchestrationTurnIndex?: number;
  orchestrationPipelineId?: string;
  /** Demanda 10100: true indica que este runtime é um subagente (depth=1). */
  isSubagent?: boolean;
  /** Demanda 10100: id do coordenador para semaphore e custo acumulado. */
  coordinatorId?: string;
}

export interface AgentToolCall {
  step: number;
  name: string;
  args: unknown;
  result: ToolResult;
  latencyMs: number;
}

export interface AgentToolsRuntimeResult {
  enabled: boolean;
  text: string;
  steps: number;
  toolCalls: AgentToolCall[];
  latencies: number[];
  totalLatencyMs: number;
  finishReason: 'stop' | 'tool_calls_exhausted' | 'max_steps' | 'error' | 'no_tools';
  error?: string;
  /** Demanda 10100: métricas de subagentes (apenas quando houver delegação). */
  delegationMetrics?: {
    delegationCount: number;
    subagentTokensUsed: number;
    subagentTimeoutOccurred: boolean;
  };
}

// ============================================================
// Cliente OpenAI
// ============================================================

/** Reset interno (testes). */
export function resetAgentToolsRuntimeCache(): void {
  resetOpenRouterClientCache();
}

// ============================================================
// Runtime Principal
// ============================================================

/**
 * Executa um agente com acesso a tools específicas do seu papel.
 *
 * @param input - Configuração do agente
 * @returns Resultado da execução com texto e histórico de tool calls
 */
export async function runAgentWithTools(
  input: AgentToolsRuntimeInput,
): Promise<AgentToolsRuntimeResult> {
  // 🟢 Guard clause: retorna resultado desabilitado se tools não estiverem habilitadas
  const toolsCheck = checkToolsEnabled(input.agentName);
  if (toolsCheck) {
    return {
      enabled: false,
      text: '',
      steps: 0,
      toolCalls: [],
      latencies: [],
      totalLatencyMs: 0,
      finishReason: 'no_tools',
    };
  }

  // Spec 012 (H-07/FR-009): execução de tools é operação sensível.
  // Bloqueio do guardrail ou proteção indisponível => nenhuma tool executa.
  const guardrailResult = await runGuardrailsOnMessagesAsync(
    [{ role: 'user', content: input.userPrompt }],
    { demandId: input.demandId, sensitiveOperation: true },
  );
  if (guardrailResult.blocked || shouldFailClosed(guardrailResult.verdict, true)) {
    const reason = guardrailResult.blocked
      ? guardrailResult.blockReason || 'guardrail_blocked'
      : 'guardrails_unavailable';
    logger.warn('Agent tools runtime bloqueado pelos guardrails', {
      context: { agentName: input.agentName, demandId: input.demandId, reason },
    });
    return {
      enabled: true,
      text: guardrailResult.blocked
        ? guardrailResult.userMessage || 'Mensagem bloqueada pelos guardrails de segurança.'
        : GUARDRAIL_UNAVAILABLE_MESSAGE,
      steps: 0,
      toolCalls: [],
      latencies: [],
      totalLatencyMs: guardrailResult.totalLatencyMs,
      finishReason: 'error',
      error: reason,
    };
  }
  input = { ...input, userPrompt: guardrailResult.messages[0]?.content ?? input.userPrompt };

  const tools = getToolsForOpenAI(input.agentName);
  const client = getOpenRouterClient('Agent tools runtime');
  const runtimeState = initializeToolsRuntime(input, tools);
  let modelToUse = runtimeState.modelToUse;
  let usedFallback = runtimeState.usedFallback;
  let finishReason: AgentToolsRuntimeResult['finishReason'] = 'max_steps';
  let finalText = '';
  // Demanda 10100: métricas de subagentes.
  let subagentTokensUsed = 0;
  let subagentTimeoutOccurred = false;

  for (let step = 0; step < runtimeState.maxSteps; step++) {
    // 🔵 Early return: processa iteração e retorna resultado se houver erro ou finalização
    const iterationResult = await processToolsIteration(
      step,
      runtimeState.maxSteps,
      runtimeState.messages,
      runtimeState.toolCallsHistory,
      runtimeState.latencies,
      modelToUse,
      usedFallback,
      input,
      client,
      tools,
    );

    if (!iterationResult.continue) {
      finishReason = (iterationResult.finishReason as typeof finishReason) || 'error';
      finalText = iterationResult.finalText || '';
      subagentTokensUsed += iterationResult.tokensUsed ?? 0;
      if (iterationResult.timeoutOccurred) subagentTimeoutOccurred = true;
      if (iterationResult.error) {
        return {
          enabled: true,
          text: '',
          steps: runtimeState.latencies.length,
          toolCalls: runtimeState.toolCallsHistory,
          latencies: runtimeState.latencies,
          totalLatencyMs: Date.now() - runtimeState.startedAt,
          finishReason: 'error',
          error: iterationResult.error,
          delegationMetrics:
            input.isSubagent === true
              ? {
                  delegationCount: 0,
                  subagentTokensUsed,
                  subagentTimeoutOccurred,
                }
              : undefined,
        };
      }
      break;
    }

    if (iterationResult.updatedModelToUse) {
      modelToUse = iterationResult.updatedModelToUse;
    }
    if (iterationResult.updatedUsedFallback !== undefined) {
      usedFallback = iterationResult.updatedUsedFallback;
    }
    if (iterationResult.stepOffset) {
      step += iterationResult.stepOffset;
    }
  }

  const totalLatencyMs = Date.now() - runtimeState.startedAt;

  logger.info('Agent tools runtime concluído', {
    context: {
      demandId: input.demandId,
      agentName: input.agentName,
      model: modelToUse,
      steps: runtimeState.latencies.length,
      toolCallsCount: runtimeState.toolCallsHistory.length,
      toolNames: [...new Set(runtimeState.toolCallsHistory.map((t) => t.name))],
      successfulCalls: runtimeState.toolCallsHistory.filter((t) => t.result.ok).length,
      finishReason,
      totalLatencyMs,
      textChars: finalText.length,
    },
  });

  return {
    enabled: true,
    text: finalText,
    steps: runtimeState.latencies.length,
    toolCalls: runtimeState.toolCallsHistory,
    latencies: runtimeState.latencies,
    totalLatencyMs,
    finishReason,
    delegationMetrics:
      input.isSubagent === true
        ? {
            delegationCount: 0,
            subagentTokensUsed,
            subagentTimeoutOccurred,
          }
        : undefined,
  };
}

/**
 * Renderiza um bloco de markdown mostrando as tools executadas.
 */
export function renderAgentToolCallsTrailer(
  agentName: string,
  result: AgentToolsRuntimeResult,
): string {
  if (!result.enabled || result.toolCalls.length === 0) return '';

  const lines = [
    '\n\n---',
    `**[Tools ${agentName}] ${result.toolCalls.length} chamada(s) — ${result.finishReason} em ${result.totalLatencyMs}ms**`,
  ];

  for (const tc of result.toolCalls) {
    const tag = tc.result.ok ? '✓' : '✗';
    const summary = tc.result.ok ? `source=${tc.result.source}` : `error=${tc.result.error}`;
    lines.push(`- ${tag} \`${tc.name}\` (${tc.latencyMs}ms) — ${summary}`);
  }

  return lines.join('\n');
}
