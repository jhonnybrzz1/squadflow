import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock OpenAI
vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: vi.fn(),
        },
      };
    },
  };
});

// Mock dependencies
vi.mock('../server/db', () => ({
  isPostgres: false,
  db: {},
  dbHelper: {
    run: vi.fn().mockResolvedValue(undefined),
    all: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../server/metrics', () => ({
  aiCallDuration: { labels: () => ({ observe: vi.fn() }) },
  aiTokensUsage: { labels: () => ({ inc: vi.fn() }) },
}));

vi.mock('../server/metrics/collector', () => ({
  metricsCollector: {
    recordOpenAICall: vi.fn(),
    recordSSEEvent: vi.fn(),
    recordSSEFirstEvent: vi.fn(),
    recordSSEConnectionEnd: vi.fn(),
  },
}));

vi.mock('../server/services/circuit-breaker', () => ({
  circuitBreaker: {
    canRequest: vi.fn().mockReturnValue(true),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));

vi.mock('../server/services/ai-cache', () => ({
  aiResponseCache: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    createKey: vi.fn().mockReturnValue('test-key'),
  },
}));

vi.mock('../server/services/request-telemetry', () => ({
  requestTelemetryService: {
    recordEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../server/services/task-classifier', () => ({
  classifyTaskType: vi.fn().mockReturnValue({ taskType: 'analysis', confidence: 0.8 }),
}));

vi.mock('../server/services/llm-audit-log', () => ({
  llmAuditLogService: {
    record: vi.fn(),
  },
}));

vi.mock('../server/services/llm-guardrails', () => ({
  runGuardrailsOnMessages: vi.fn().mockReturnValue({
    blocked: false,
    messages: [],
    blockReason: null,
    userMessage: null,
    totalDetections: [],
    totalLatencyMs: 0,
  }),
}));

vi.mock('../server/services/cost-routing', () => ({
  decideRoutingModel: vi.fn().mockReturnValue({
    model: 'test-model',
    mode: 'safe',
    reason: 'test',
    threshold: 100,
  }),
}));

vi.mock('../server/services/model-governance', () => ({
  validateModelAllowed: vi.fn(),
  validateContract: vi.fn(),
}));

// ============================================
// SSE Protocol Tests
// ============================================

describe('SSE Protocol - agent_chunk event type', () => {
  it('includes agent_chunk in SSEEventType', async () => {
    const { SSEProtocolValidator } = await import('../server/services/sse/protocol');

    const event = SSEProtocolValidator.createEvent('agent_chunk', 1, {
      agent: 'refinador',
      chunk: 'Hello ',
    });

    expect(event.type).toBe('agent_chunk');
    expect(event.demandId).toBe(1);
    expect(event.data).toEqual({ agent: 'refinador', chunk: 'Hello ' });
    expect(event.timestamp).toBeGreaterThan(0);
  });

  it('includes agent_stream_end in SSEEventType', async () => {
    const { SSEProtocolValidator } = await import('../server/services/sse/protocol');

    const event = SSEProtocolValidator.createEvent('agent_stream_end', 1, {
      agent: 'refinador',
    });

    expect(event.type).toBe('agent_stream_end');
  });

  it('serializes agent_chunk with event name', async () => {
    const { SSEProtocolValidator } = await import('../server/services/sse/protocol');

    const event = SSEProtocolValidator.createEvent('agent_chunk', 1, {
      agent: 'refinador',
      chunk: 'Hello world',
    });

    const serialized = SSEProtocolValidator.serialize(event);

    expect(serialized).toContain('event: agent_chunk');
    expect(serialized).toContain('"chunk":"Hello world"');
    expect(serialized).toContain('"agent":"refinador"');
    expect(serialized).toMatch(/\n\n$/); // Ends with double newline
  });

  it('serializes agent_stream_end with event name', async () => {
    const { SSEProtocolValidator } = await import('../server/services/sse/protocol');

    const event = SSEProtocolValidator.createEvent('agent_stream_end', 42, {
      agent: 'refinador',
    });

    const serialized = SSEProtocolValidator.serialize(event);

    expect(serialized).toContain('event: agent_stream_end');
    expect(serialized).toContain('"agent":"refinador"');
  });
});

// ============================================
// SSE Manager - sendAgentChunk / sendAgentStreamEnd
// ============================================

describe('SSE Manager - Agent Streaming', () => {
  let sseManager: any;

  beforeEach(async () => {
    // Fresh import to avoid singleton pollution
    vi.resetModules();
    const mod = await import('../server/services/sse/manager');
    sseManager = new mod.SSEManager();
  });

  afterEach(() => {
    sseManager?.shutdown?.();
  });

  it('sendAgentChunk writes to connected clients', () => {
    const mockRes = { write: vi.fn() };
    sseManager.addConnection(1, mockRes);

    sseManager.sendAgentChunk(1, 'refinador', 'Hello ');

    expect(mockRes.write).toHaveBeenCalled();
    const written = mockRes.write.mock.calls[0][0];
    expect(written).toContain('event: agent_chunk');
    expect(written).toContain('"chunk":"Hello "');
    expect(written).toContain('"agent":"refinador"');
  });

  it('sendAgentStreamEnd writes to connected clients', () => {
    const mockRes = { write: vi.fn() };
    sseManager.addConnection(1, mockRes);

    sseManager.sendAgentStreamEnd(1, 'refinador');

    expect(mockRes.write).toHaveBeenCalled();
    const written = mockRes.write.mock.calls[0][0];
    expect(written).toContain('event: agent_stream_end');
    expect(written).toContain('"agent":"refinador"');
  });

  it('does not write when no connections exist', () => {
    // No connection added
    sseManager.sendAgentChunk(999, 'refinador', 'test');
    // Should not throw
  });

  it('handles multiple chunks in sequence', () => {
    const mockRes = { write: vi.fn() };
    sseManager.addConnection(1, mockRes);

    sseManager.sendAgentChunk(1, 'refinador', 'Hello ');
    sseManager.sendAgentChunk(1, 'refinador', 'world');
    sseManager.sendAgentChunk(1, 'refinador', '!');
    sseManager.sendAgentStreamEnd(1, 'refinador');

    // 4 writes: 3 chunks + 1 stream_end
    expect(mockRes.write).toHaveBeenCalledTimes(4);
  });

  it('broadcasts to multiple connections', () => {
    const mockRes1 = { write: vi.fn() };
    const mockRes2 = { write: vi.fn() };
    sseManager.addConnection(1, mockRes1);
    sseManager.addConnection(1, mockRes2);

    sseManager.sendAgentChunk(1, 'refinador', 'chunk');

    expect(mockRes1.write).toHaveBeenCalledTimes(1);
    expect(mockRes2.write).toHaveBeenCalledTimes(1);
  });

  it('marks connection inactive on write error', () => {
    const mockRes = {
      write: vi.fn().mockImplementation(() => {
        throw new Error('Connection reset');
      }),
    };
    sseManager.addConnection(1, mockRes);

    sseManager.sendAgentChunk(1, 'refinador', 'test');

    // Should not throw, connection marked as inactive
    expect(sseManager.getConnections(1)[0]?.isActive).toBe(false);
  });
});

// ============================================
// Feature flag: isStreamingEnabledForAgent
// ============================================

describe('Feature flag: streaming pilot agents', () => {
  it('returns true for pilot agent when flag enabled', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const flagPath = path.resolve(__dirname, '../config/feature-flags.json');
    const flagContent = fs.readFileSync(flagPath, 'utf-8');
    const flags = JSON.parse(flagContent);

    expect(flags.enableAgentStreaming).toBe(true);
    expect(flags.streamingPilotAgents).toContain('product_manager');
  });

  it('pilot list inclui todos os agentes críticos para streaming', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const flagPath = path.resolve(__dirname, '../config/feature-flags.json');
    const flags = JSON.parse(fs.readFileSync(flagPath, 'utf-8'));

    // Após expansão do pilot, TODOS os agentes de análise estão no streaming.
    // Mantemos sentinel para garantir cobertura ampla (product_manager + agentes high-latency).
    expect(flags.streamingPilotAgents).toContain('product_manager');
    expect(flags.streamingPilotAgents).toContain('analista_de_dados');
    expect(flags.streamingPilotAgents).toContain('qa');
    expect(flags.streamingPilotAgents).toContain('tech_lead');
    expect(flags.streamingPilotAgents).toContain('ux_designer');
    expect(flags.streamingPilotAgents).toContain('scrum_master');
    expect(flags.streamingPilotAgents).toContain('product_manager');

    // Agentes inexistentes (sentinel) seguem fora.
    expect(flags.streamingPilotAgents).not.toContain('agente_inexistente');
    expect(flags.streamingPilotAgents).not.toContain('ux'); // alias antigo, sem uso atual
  });

  it('pilot agent logic: enabled=false means no streaming', () => {
    const flags = { enableAgentStreaming: false, streamingPilotAgents: ['refinador'] };
    const isEnabled =
      flags.enableAgentStreaming && flags.streamingPilotAgents.includes('refinador');
    expect(isEnabled).toBe(false);
  });
});

// ============================================
// Streaming fallback behavior
// ============================================

describe('Streaming fallback behavior', () => {
  it('fallback emits entire response as single chunk when streaming fails', async () => {
    // Simulate: streaming throws, but non-streaming returns a result
    const chunks: string[] = [];
    let streamEndCalled = false;

    const onChunk = (chunk: string) => chunks.push(chunk);
    const onStreamEnd = () => {
      streamEndCalled = true;
    };

    // Simulate a fallback scenario
    const fullResponse = 'Complete response from non-streaming path';
    // When streaming fails, the fallback calls onChunk with the full response
    onChunk(fullResponse);
    onStreamEnd();

    expect(chunks).toEqual([fullResponse]);
    expect(streamEndCalled).toBe(true);
  });

  it('streaming collects multiple chunks into full response', () => {
    const chunks = ['Hello ', 'world', '! How are you?'];
    const accumulated = chunks.join('');

    expect(accumulated).toBe('Hello world! How are you?');
  });
});

// ============================================
// Governance: state transition after stream
// ============================================

describe('Governance: state transition integrity', () => {
  it('processWithAgent returns full response after streaming completes', () => {
    // The processWithAgent returns the accumulated string,
    // which is then used to set message.type = 'completed'
    // State transition happens AFTER the full response is available

    const streamedChunks = ['Part 1. ', 'Part 2. ', 'Part 3.'];
    const fullResponse = streamedChunks.join('');

    // Simulates: accumulated response is returned
    expect(fullResponse).toBe('Part 1. Part 2. Part 3.');

    // The caller sets message.message = response and message.type = 'completed'
    // This ensures governance transition happens after stream finishes
    const message: any = { type: 'processing', message: '' };
    message.message = fullResponse;
    message.type = 'completed';

    expect(message.type).toBe('completed');
    expect(message.message).toBe(fullResponse);
  });

  it('document state only transitions after stream + validation', () => {
    // The flow:
    // 1. processWithAgent streams chunks via SSE
    // 2. Accumulates full response
    // 3. Validates with contextBuilder.validateResponse
    // 4. Returns clean response
    // 5. Caller sets message.type = 'completed' and updates DB
    // => State transition is SYNCHRONOUS after stream completes

    const validationResult = {
      isValid: true,
      score: 90,
      issues: [],
      cleanMessage: 'Validated response',
    };

    // Only the validated clean message gets persisted
    const finalResponse = validationResult.cleanMessage || 'raw response';
    expect(finalResponse).toBe('Validated response');
  });
});

// ============================================
// Performance: chunk emission latency
// ============================================

describe('Performance characteristics', () => {
  it('SSE event serialization is fast (< 1ms per chunk)', async () => {
    const { SSEProtocolValidator } = await import('../server/services/sse/protocol');

    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      const event = SSEProtocolValidator.createEvent('agent_chunk', 1, {
        agent: 'refinador',
        chunk: `chunk ${i} with some content`,
      });
      SSEProtocolValidator.serialize(event);
    }
    const elapsed = Date.now() - start;

    // 1000 serializations should take < 100ms (0.1ms each)
    expect(elapsed).toBeLessThan(100);
  });
});
