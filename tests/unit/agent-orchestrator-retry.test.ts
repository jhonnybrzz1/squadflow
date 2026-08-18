import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  orchestratorAgentMaxRetries: 3,
}));

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const mockAgentFailureLogger = vi.hoisted(() => ({
  log: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../server/config/env', () => ({
  env: mockEnv,
}));

vi.mock('../../server/utils/logger', () => ({
  logger: mockLogger,
}));

vi.mock('../../server/services/agent-failure-logger', () => ({
  agentFailureLogger: mockAgentFailureLogger,
}));

vi.mock('../../server/db', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    db: {
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    },
  };
});

import { AgentOrchestrator } from '../../server/cognitive-core/agent-orchestrator';

describe('A-1: AgentOrchestrator retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retorna sucesso no primeiro try', async () => {
    const deps = {
      demandRepository: {
        findById: vi.fn().mockResolvedValue({ id: 1, title: 'Test' }),
      },
      agentInteractionService: {
        executeAgent: vi.fn().mockResolvedValue('result'),
      },
      contextBuilder: {
        validateAgentResponse: vi.fn().mockResolvedValue({
          isValid: true,
          cleanMessage: 'clean',
          evidence: [],
        }),
        recordVerifiedEvidence: vi.fn(),
      },
      featureFlags: {} as any,
      eventBus: {} as any,
    };

    const orchestrator = new AgentOrchestrator(deps);
    const result = await orchestrator.executeAgent(1, 'agent-x');

    expect(result.success).toBe(true);
    expect(result.agentName).toBe('agent-x');
    expect(deps.agentInteractionService.executeAgent).toHaveBeenCalledOnce();
    expect(mockAgentFailureLogger.log).not.toHaveBeenCalled();
  });

  it('retry até maxRetries e registra agent failure', async () => {
    mockEnv.orchestratorAgentMaxRetries = 2;
    const deps = {
      demandRepository: {
        findById: vi.fn().mockResolvedValue({ id: 1 }),
      },
      agentInteractionService: {
        executeAgent: vi.fn().mockRejectedValue(new Error('schema validation failed')),
      },
      contextBuilder: {
        validateAgentResponse: vi.fn(),
        recordVerifiedEvidence: vi.fn(),
      },
      featureFlags: {} as any,
      eventBus: {} as any,
    };

    const orchestrator = new AgentOrchestrator(deps);
    const promise = orchestrator.executeAgent(1, 'agent-x');
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(deps.agentInteractionService.executeAgent).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(false);
    expect(result.message).toContain('after 3 attempts');
    expect(mockAgentFailureLogger.log).toHaveBeenCalledOnce();
    const logCall = mockAgentFailureLogger.log.mock.calls[0][0];
    expect(logCall).toMatchObject({
      agentId: 'agent-x',
      taskId: '1',
      errorCategory: 'schema_validation',
      attempt: 2,
    });
    expect(logCall.executionId).toBeTruthy();
  });

  it('categoriza timeout', async () => {
    mockEnv.orchestratorAgentMaxRetries = 0;
    const deps = {
      demandRepository: {
        findById: vi.fn().mockResolvedValue({ id: 1 }),
      },
      agentInteractionService: {
        executeAgent: vi.fn().mockRejectedValue(new Error('timeout on API call')),
      },
      contextBuilder: {
        validateAgentResponse: vi.fn(),
        recordVerifiedEvidence: vi.fn(),
      },
      featureFlags: {} as any,
      eventBus: {} as any,
    };

    const orchestrator = new AgentOrchestrator(deps);
    const promise = orchestrator.executeAgent(1, 'agent-x');
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(mockAgentFailureLogger.log).toHaveBeenCalledOnce();
    expect(mockAgentFailureLogger.log.mock.calls[0][0].errorCategory).toBe('timeout');
  });

  it('MAX_RETRIES=0 faz 1 tentativa e falha', async () => {
    mockEnv.orchestratorAgentMaxRetries = 0;
    const deps = {
      demandRepository: {
        findById: vi.fn().mockResolvedValue({ id: 1 }),
      },
      agentInteractionService: {
        executeAgent: vi.fn().mockRejectedValue(new Error('always fails')),
      },
      contextBuilder: {
        validateAgentResponse: vi.fn(),
        recordVerifiedEvidence: vi.fn(),
      },
      featureFlags: {} as any,
      eventBus: {} as any,
    };

    const orchestrator = new AgentOrchestrator(deps);
    const promise = orchestrator.executeAgent(1, 'agent-x');
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(deps.agentInteractionService.executeAgent).toHaveBeenCalledTimes(1);
    expect(mockAgentFailureLogger.log).toHaveBeenCalledOnce();
  });
});
