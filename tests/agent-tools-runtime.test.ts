import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ============================================================
// vi.hoisted — mock factory compartilhada pelo escopo do módulo
// ============================================================

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

// ============================================================
// Mocks
// ============================================================

vi.mock('openai', () => {
  class OpenAIMock {
    public chat = { completions: { create: createMock } };
    constructor(_opts?: unknown) {}
  }
  return { default: OpenAIMock };
});

vi.mock('../server/services/agent-tools-registry', () => ({
  isAgentToolsEnabled: vi.fn(),
  getToolsForOpenAI: vi.fn(),
  executeToolForAgent: vi.fn(),
}));

// ai-usage-tracker is used transitively via tool-telemetry.ts
vi.mock('../server/services/llm-guardrails', () => ({
  runGuardrailsOnMessagesAsync: vi.fn(async (messages: unknown) => ({
    blocked: false,
    messages,
    blockReason: null,
    userMessage: null,
    totalDetections: [],
    totalLatencyMs: 0,
    semanticFlagged: false,
    verdict: 'benign',
  })),
  shouldFailClosed: vi.fn(() => false),
  GUARDRAIL_UNAVAILABLE_MESSAGE: 'guardrail indisponível',
}));

vi.mock('../server/services/ai-usage-tracker', () => ({
  aiUsageTracker: {
    record: vi.fn(),
  },
}));

// ============================================================
// Imports (após os mocks)
// ============================================================

import {
  runAgentWithTools,
  renderAgentToolCallsTrailer,
  resetAgentToolsRuntimeCache,
  type AgentToolsRuntimeResult,
} from '../server/services/agent-tools-runtime';
import {
  isAgentToolsEnabled,
  getToolsForOpenAI,
  executeToolForAgent,
} from '../server/services/agent-tools-registry';
import { aiUsageTracker } from '../server/services/ai-usage-tracker';

const mockedIsEnabled = vi.mocked(isAgentToolsEnabled);
const mockedGetTools = vi.mocked(getToolsForOpenAI);
const mockedExecute = vi.mocked(executeToolForAgent);
const mockedRecord = vi.mocked(aiUsageTracker.record);

// ============================================================
// Helper — constrói uma resposta LLM mockada
// ============================================================

function buildResponse(opts: {
  content?: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: opts.content ?? null,
          ...(opts.toolCalls
            ? {
                tool_calls: opts.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: tc.arguments },
                })),
              }
            : {}),
        },
      },
    ],
  };
}

/** Formato de tool OpenAI para os mocks de getToolsForOpenAI */
const MOCK_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'mock_tool',
      description: 'A mock tool',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// ============================================================
// Suite
// ============================================================

describe('agent-tools-runtime', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    resetAgentToolsRuntimeCache();
    process.env.OPENROUTER_API_KEY = 'sk-test-key';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // ----------------------------------------------------------
  // 1. no_tools quando isAgentToolsEnabled retorna false
  // ----------------------------------------------------------
  it("retorna finishReason 'no_tools' quando isAgentToolsEnabled retorna false", async () => {
    mockedIsEnabled.mockReturnValue(false);

    const result = await runAgentWithTools({
      systemPrompt: 'sys',
      userPrompt: 'user',
      agentName: 'tech_lead',
    });

    expect(result.enabled).toBe(false);
    expect(result.text).toBe('');
    expect(result.finishReason).toBe('no_tools');
    expect(createMock).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------
  // 2. no_tools quando getToolsForOpenAI retorna array vazio
  // ----------------------------------------------------------
  it("retorna finishReason 'no_tools' quando getToolsForOpenAI retorna array vazio", async () => {
    mockedIsEnabled.mockReturnValue(true);
    mockedGetTools.mockReturnValue([]);

    const result = await runAgentWithTools({
      systemPrompt: 'sys',
      userPrompt: 'user',
      agentName: 'tech_lead',
    });

    expect(result.enabled).toBe(false);
    expect(result.finishReason).toBe('no_tools');
    expect(createMock).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------
  // 3. Resposta sem tool_calls → finishReason 'stop', text correto
  // ----------------------------------------------------------
  it("resposta sem tool_calls retorna finishReason 'stop' e text correto", async () => {
    mockedIsEnabled.mockReturnValue(true);
    mockedGetTools.mockReturnValue(MOCK_TOOLS);
    createMock.mockResolvedValueOnce(buildResponse({ content: 'resposta final do agente' }));

    const result = await runAgentWithTools({
      systemPrompt: 'sys',
      userPrompt: 'user',
      agentName: 'tech_lead',
      model: 'deepseek/deepseek-v4-pro',
    });

    expect(result.enabled).toBe(true);
    expect(result.text).toBe('resposta final do agente');
    expect(result.steps).toBe(1);
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toEqual([]);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  // ----------------------------------------------------------
  // 4. Executa tool_call e re-chama LLM → finishReason 'stop', toolCalls com 1 entrada
  // ----------------------------------------------------------
  it("executa tool_call e re-chama LLM com resultado, retorna finishReason 'stop'", async () => {
    mockedIsEnabled.mockReturnValue(true);
    mockedGetTools.mockReturnValue(MOCK_TOOLS);
    mockedExecute.mockResolvedValueOnce({ ok: true, data: { result: 42 }, source: 'mock' });

    createMock
      .mockResolvedValueOnce(
        buildResponse({
          toolCalls: [{ id: 'call_1', name: 'mock_tool', arguments: '{"param":"value"}' }],
        }),
      )
      .mockResolvedValueOnce(buildResponse({ content: 'síntese após tool' }));

    const result = await runAgentWithTools({
      systemPrompt: 'sys',
      userPrompt: 'preciso de informação',
      agentName: 'tech_lead',
    });

    expect(result.text).toBe('síntese após tool');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('mock_tool');
    expect(result.toolCalls[0].args).toEqual({ param: 'value' });
    expect(result.toolCalls[0].result.ok).toBe(true);
    expect(result.steps).toBe(2);
    expect(result.finishReason).toBe('stop');
    expect(mockedExecute).toHaveBeenCalledWith('tech_lead', 'mock_tool', { param: 'value' });
  });

  // ----------------------------------------------------------
  // 5. Respeita maxSteps=2 → finishReason 'tool_calls_exhausted'
  // ----------------------------------------------------------
  it("respeita maxSteps=2 e retorna finishReason 'tool_calls_exhausted'", async () => {
    mockedIsEnabled.mockReturnValue(true);
    mockedGetTools.mockReturnValue(MOCK_TOOLS);
    mockedExecute.mockResolvedValue({ ok: true, data: {}, source: 'mock' });

    createMock
      .mockResolvedValueOnce(
        buildResponse({
          toolCalls: [{ id: 'call_a', name: 'mock_tool', arguments: '{"x":1}' }],
        }),
      )
      .mockResolvedValueOnce(
        buildResponse({
          toolCalls: [{ id: 'call_b', name: 'mock_tool', arguments: '{"x":2}' }],
        }),
      )
      .mockResolvedValueOnce(buildResponse({ content: 'síntese final pós-tools' }));

    const result = await runAgentWithTools({
      systemPrompt: 'sys',
      userPrompt: 'user',
      agentName: 'tech_lead',
      maxSteps: 2,
    });

    expect(result.finishReason).toBe('tool_calls_exhausted');
    expect(result.text).toBe('síntese final pós-tools');
    expect(result.toolCalls).toHaveLength(2);
  });

  // ----------------------------------------------------------
  // 6. Fallback de modelo quando primário lança erro
  // ----------------------------------------------------------
  it('usa modelo fallback quando primário falha', async () => {
    mockedIsEnabled.mockReturnValue(true);
    mockedGetTools.mockReturnValue(MOCK_TOOLS);

    createMock
      .mockRejectedValueOnce(new Error('primary down'))
      .mockResolvedValueOnce(buildResponse({ content: 'recuperado pelo fallback' }));

    const result = await runAgentWithTools({
      systemPrompt: 'sys',
      userPrompt: 'user',
      agentName: 'tech_lead',
      model: 'primary-model',
      modelFallback: 'fallback-model',
    });

    expect(result.text).toBe('recuperado pelo fallback');
    expect(result.finishReason).toBe('stop');
    // A segunda chamada (fallback) deve usar o modelo de fallback
    const secondCall = createMock.mock.calls[1][0];
    expect(secondCall.model).toBe('fallback-model');
  });

  // ----------------------------------------------------------
  // 7. finishReason 'error' quando LLM falha sem fallback
  // ----------------------------------------------------------
  it("retorna finishReason 'error' quando LLM falha sem fallback", async () => {
    mockedIsEnabled.mockReturnValue(true);
    mockedGetTools.mockReturnValue(MOCK_TOOLS);
    createMock.mockRejectedValueOnce(new Error('explosão total'));

    const result = await runAgentWithTools({
      systemPrompt: 'sys',
      userPrompt: 'user',
      agentName: 'tech_lead',
    });

    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('explosão total');
  });

  // ----------------------------------------------------------
  // 8–10. renderAgentToolCallsTrailer
  // ----------------------------------------------------------
  describe('renderAgentToolCallsTrailer', () => {
    it("retorna '' quando result.enabled=false", () => {
      const result: AgentToolsRuntimeResult = {
        enabled: false,
        text: '',
        steps: 0,
        toolCalls: [],
        latencies: [],
        totalLatencyMs: 0,
        finishReason: 'no_tools',
      };
      expect(renderAgentToolCallsTrailer('TechLead', result)).toBe('');
    });

    it("retorna '' quando toolCalls está vazio", () => {
      const result: AgentToolsRuntimeResult = {
        enabled: true,
        text: '',
        steps: 1,
        toolCalls: [],
        latencies: [10],
        totalLatencyMs: 10,
        finishReason: 'stop',
      };
      expect(renderAgentToolCallsTrailer('TechLead', result)).toBe('');
    });

    it('retorna markdown com nome do agente e tool calls quando há chamadas', () => {
      const result: AgentToolsRuntimeResult = {
        enabled: true,
        text: 'análise concluída',
        steps: 2,
        toolCalls: [
          {
            step: 0,
            name: 'get_repo_structure',
            args: { repo: 'my-service' },
            result: { ok: true, data: { files: [] }, source: 'github' },
            latencyMs: 120,
          },
          {
            step: 1,
            name: 'get_demand_history',
            args: { demandId: 42 },
            result: { ok: false, error: 'demanda não encontrada', source: 'db' },
            latencyMs: 5,
          },
        ],
        latencies: [300, 250],
        totalLatencyMs: 550,
        finishReason: 'stop',
      };

      const trailer = renderAgentToolCallsTrailer('TechLead', result);

      expect(trailer).toContain('TechLead');
      expect(trailer).toContain('✓ `get_repo_structure`');
      expect(trailer).toContain('✗ `get_demand_history`');
      expect(trailer).toContain('error=demanda não encontrada');
    });
  });

  // ----------------------------------------------------------
  // Extra: aiUsageTracker.record é chamado após execução de tool
  // ----------------------------------------------------------
  it('chama aiUsageTracker.record após execução de tool', async () => {
    mockedIsEnabled.mockReturnValue(true);
    mockedGetTools.mockReturnValue(MOCK_TOOLS);
    mockedExecute.mockResolvedValueOnce({ ok: true, data: {}, source: 'mock' });

    createMock
      .mockResolvedValueOnce(
        buildResponse({
          toolCalls: [{ id: 'call_1', name: 'mock_tool', arguments: '{}' }],
        }),
      )
      .mockResolvedValueOnce(buildResponse({ content: 'done' }));

    await runAgentWithTools({
      systemPrompt: 'sys',
      userPrompt: 'user',
      agentName: 'tech_lead',
      demandId: 99,
    });

    expect(mockedRecord).toHaveBeenCalledTimes(1);
    expect(mockedRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'tool:mock_tool',
        model: 'agent-tool',
        demandId: 99,
      }),
    );
  });
});
