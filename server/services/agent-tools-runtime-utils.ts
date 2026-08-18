import type {
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
  ChatCompletionTool,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import type OpenAI from 'openai';
import { logger } from '../utils/logger';
import type { AgentToolsRuntimeInput, AgentToolCall } from './agent-tools-runtime';
import { getToolsForOpenAI, isAgentToolsEnabled, type ToolResult } from './agent-tools-registry';
import { executeToolForAgent } from './agent-tools-registry';
import { recordToolUsage } from './tool-telemetry';
import { XIAOMI_PRO_MODEL } from './llm-model-router';
import { eventBus } from '../events/event-bus';
import { featureFlags } from './feature-flags';

export interface ToolCallResult {
  tc: ChatCompletionMessageToolCall;
  name: string;
  args: unknown;
  result: ToolResult;
  latencyMs: number;
}

/**
 * Executa uma chamada LLM com fallback automático
 *
 * 🔵 Early return: retorna erro se fallback não disponível
 */
export async function executeLLMCallWithFallback(
  client: OpenAI,
  modelToUse: string,
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  temperature: number,
  maxTokens: number,
  input: AgentToolsRuntimeInput,
  usedFallback: boolean,
): Promise<{
  completion: OpenAI.ChatCompletion | null;
  usedFallback: boolean;
  error?: string;
  tokensUsed?: number;
}> {
  // Demanda 10100: subagentes usam timeout de 30s via AbortController.
  const isSubagent = input.isSubagent === true;
  let abortSignal: AbortSignal | undefined;
  if (isSubagent) {
    const flags = featureFlags.getFlags();
    const timeoutMs =
      typeof flags?.subagentTimeoutMs === 'number' && flags.subagentTimeoutMs > 0
        ? flags.subagentTimeoutMs
        : 30000;
    abortSignal = AbortSignal.timeout(timeoutMs);
  }

  try {
    const completion = await client.chat.completions.create(
      {
        model: modelToUse,
        messages,
        tools,
        tool_choice: 'auto',
        temperature,
        max_tokens: maxTokens,
      },
      { signal: abortSignal },
    );
    const tokensUsed = completion.usage?.total_tokens ?? 0;
    return { completion, usedFallback, tokensUsed };
  } catch (err) {
    if (!usedFallback && input.modelFallback && input.modelFallback !== modelToUse) {
      logger.warn('Agent tools runtime: model primário falhou, usando fallback', {
        error: err instanceof Error ? err : undefined,
        context: { from: modelToUse, to: input.modelFallback },
      });
      return { completion: null, usedFallback: true, error: 'FALLBACK_TRIGGERED' };
    }

    const message = err instanceof Error ? err.message : 'erro desconhecido';
    logger.error('Agent tools runtime: chamada LLM falhou', {
      error: err instanceof Error ? err : undefined,
      context: { model: modelToUse, demandId: input.demandId },
    });
    return { completion: null, usedFallback, error: message };
  }
}

/**
 * Executa todas as tools de um step em paralelo
 */
export async function executeToolCallsInParallel(
  toolCalls: ChatCompletionMessageToolCall[],
  step: number,
  input: AgentToolsRuntimeInput,
): Promise<ToolCallResult[]> {
  const functionCalls = toolCalls.filter((tc) => tc.type === 'function');
  return Promise.all(
    functionCalls.map(async (tc) => {
      const name = tc.function.name;
      let args: unknown = {};
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch (parseErr) {
        logger.warn('Falha ao fazer parse dos argumentos da tool_call', {
          error: parseErr instanceof Error ? parseErr : undefined,
          context: { toolName: name, rawArgs: tc.function.arguments?.slice(0, 200) },
        });
        args = { __raw: tc.function.arguments };
      }
      const toolStart = Date.now();
      let result: ToolResult;
      let latencyMs: number;
      try {
        result = await executeToolForAgent(input.agentName, name, args);
        latencyMs = Date.now() - toolStart;
      } catch (err) {
        latencyMs = Date.now() - toolStart;
        const failedResult: ToolResult = {
          ok: false,
          error: err instanceof Error ? err.message : 'Tool execution failed',
          source: name,
        };
        emitToolCallEvent(input, step, name, args, failedResult, latencyMs);
        recordToolUsage({
          name,
          demandId: input.demandId,
          latencyMs,
          ok: false,
          model: 'agent-tool',
        });
        throw err;
      }
      recordToolUsage({
        name,
        demandId: input.demandId,
        latencyMs,
        ok: result.ok,
        model: 'agent-tool',
      });
      emitToolCallEvent(input, step, name, args, result, latencyMs);
      return { tc, name, args, result, latencyMs };
    }),
  );
}

function emitToolCallEvent(
  input: AgentToolsRuntimeInput,
  step: number,
  toolName: string,
  args: unknown,
  result: ToolResult,
  latencyMs: number,
): void {
  if (!input.orchestrationRunId || typeof input.demandId !== 'number') return;
  const status = result.ok ? 'completed' : 'failed';
  eventBus.publish(status === 'completed' ? 'TOOL_CALL_COMPLETED' : 'TOOL_CALL_FAILED', {
    timestamp: new Date().toISOString(),
    runId: input.orchestrationRunId,
    turnId: input.orchestrationTurnId,
    turnIndex: input.orchestrationTurnIndex,
    pipelineId: input.orchestrationPipelineId,
    demandId: input.demandId,
    agentName: input.agentName,
    toolName,
    status,
    argsJson: toJsonObject(args),
    resultJson: toJsonObject(result),
    errorMessage: result.ok ? null : (result.error ?? 'Tool call failed'),
    durationMs: latencyMs,
    metadata: { step },
  });
}

function toJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

/**
 * Executa chamada final pós-tools para obter resposta sem novas tools
 */
export async function executeFinalLLMCall(
  client: OpenAI,
  modelToUse: string,
  messages: ChatCompletionMessageParam[],
  temperature: number,
  maxTokens: number,
  agentName: string,
): Promise<{ text: string; latencyMs: number; error?: boolean; tokensUsed?: number }> {
  const finalStart = Date.now();
  try {
    const finalCompletion = await client.chat.completions.create({
      model: modelToUse,
      messages,
      temperature,
      max_tokens: maxTokens,
    });
    const latencyMs = Date.now() - finalStart;
    const text = finalCompletion.choices?.[0]?.message?.content ?? '';
    const tokensUsed = finalCompletion.usage?.total_tokens ?? 0;
    return { text, latencyMs, error: false, tokensUsed };
  } catch (err) {
    logger.warn('Agent tools runtime: falha na chamada final pós-tools', {
      error: err instanceof Error ? err : undefined,
      context: { agentName },
    });
    return { text: '', latencyMs: Date.now() - finalStart, error: true };
  }
}

/**
 * Verifica se tools estão habilitadas e disponíveis para o agente
 *
 * 🟢 Guard clause: retorna resultado desabilitado se tools não estiverem habilitadas
 */
export function checkToolsEnabled(agentName: string): { enabled: false; reason: string } | null {
  if (!isAgentToolsEnabled(agentName)) {
    return { enabled: false, reason: 'no_tools' };
  }

  const tools = getToolsForOpenAI(agentName);
  if (tools.length === 0) {
    return { enabled: false, reason: 'no_tools' };
  }

  return null;
}

/**
 * Inicializa o estado do runtime de tools
 */
export function initializeToolsRuntime(
  input: AgentToolsRuntimeInput,
  _tools: ChatCompletionTool[],
) {
  const maxSteps = input.maxSteps ?? 4;
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: input.systemPrompt },
    { role: 'user', content: input.userPrompt },
  ];
  const toolCallsHistory: AgentToolCall[] = [];
  const latencies: number[] = [];
  const modelToUse = input.model || XIAOMI_PRO_MODEL;
  const usedFallback = false;

  return {
    maxSteps,
    messages,
    toolCallsHistory,
    latencies,
    modelToUse,
    usedFallback,
    startedAt: Date.now(),
  };
}

/**
 * Processa uma única iteração do loop de tools
 *
 * 🔵 Early return: retorna erro se LLM falhar
 */
export async function processToolsIteration(
  step: number,
  maxSteps: number,
  messages: ChatCompletionMessageParam[],
  toolCallsHistory: AgentToolCall[],
  latencies: number[],
  modelToUse: string,
  usedFallback: boolean,
  input: AgentToolsRuntimeInput,
  client: OpenAI,
  tools: ChatCompletionTool[],
): Promise<{
  continue: boolean;
  finishReason?: string;
  finalText?: string;
  updatedModelToUse?: string;
  updatedUsedFallback?: boolean;
  error?: string;
  stepOffset?: number;
  tokensUsed?: number;
  timeoutOccurred?: boolean;
}> {
  const stepStart = Date.now();

  // Execute LLM call with fallback
  const {
    completion,
    usedFallback: _fallbackUsed,
    error: llmError,
    tokensUsed,
  } = await executeLLMCallWithFallback(
    client,
    modelToUse,
    messages,
    tools,
    input.temperature ?? 0.4,
    input.maxTokens ?? 6000,
    input,
    usedFallback,
  );

  // Handle fallback trigger
  if (llmError === 'FALLBACK_TRIGGERED') {
    return {
      continue: true,
      updatedModelToUse: input.modelFallback || modelToUse,
      updatedUsedFallback: true,
      stepOffset: -1,
    };
  }

  // Handle LLM error (inclui timeout de subagente)
  if (llmError) {
    const timeoutOccurred = input.isSubagent === true && /aborted|timeout|cancel/i.test(llmError);
    return {
      continue: false,
      finishReason: timeoutOccurred ? 'error' : 'error',
      error: llmError,
      tokensUsed: tokensUsed ?? 0,
      timeoutOccurred,
    };
  }

  latencies.push(Date.now() - stepStart);
  const choice = completion?.choices?.[0];
  const assistantMessage = choice?.message;

  if (!assistantMessage) {
    return {
      continue: false,
      finishReason: 'error',
      tokensUsed: tokensUsed ?? 0,
    };
  }

  // Add assistant response to history
  messages.push({
    role: 'assistant',
    content: assistantMessage.content ?? null,
    ...(assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0
      ? { tool_calls: assistantMessage.tool_calls }
      : {}),
  } as ChatCompletionMessageParam);

  const toolCalls = assistantMessage.tool_calls;

  // No tool_calls → final response
  if (!toolCalls || toolCalls.length === 0) {
    return {
      continue: false,
      finishReason: 'stop',
      finalText: assistantMessage.content ?? '',
      tokensUsed: tokensUsed ?? 0,
    };
  }

  // Execute all tools in parallel
  const toolResults = await executeToolCallsInParallel(toolCalls, step, input);

  for (const { tc, name, args, result, latencyMs } of toolResults) {
    toolCallsHistory.push({ step, name, args, result, latencyMs });
    messages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: JSON.stringify(result),
    } as ChatCompletionToolMessageParam);
  }

  // Last iteration — request final response without new tools
  if (step === maxSteps - 1) {
    const {
      text,
      latencyMs: finalLatencyMs,
      error: finalError,
      tokensUsed: finalTokensUsed,
    } = await executeFinalLLMCall(
      client,
      modelToUse,
      messages,
      input.temperature ?? 0.4,
      input.maxTokens ?? 6000,
      input.agentName,
    );
    latencies.push(finalLatencyMs);
    return {
      continue: false,
      finishReason: finalError ? 'error' : 'tool_calls_exhausted',
      finalText: text,
      tokensUsed: (tokensUsed ?? 0) + (finalTokensUsed ?? 0),
    };
  }

  return { continue: true, tokensUsed: tokensUsed ?? 0 };
}
