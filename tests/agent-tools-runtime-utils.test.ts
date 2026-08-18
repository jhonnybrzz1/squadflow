import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeLLMCallWithFallback,
  executeToolCallsInParallel,
  executeFinalLLMCall,
} from '../server/services/agent-tools-runtime-utils';

// Mock dependencies
vi.mock('../server/services/openrouter-client', () => ({
  getOpenRouterClient: vi.fn(() => ({
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
  })),
}));

vi.mock('../server/utils/logger', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../server/services/agent-tools-registry', () => ({
  executeToolForAgent: vi.fn(),
}));

vi.mock('../server/services/tool-telemetry', () => ({
  recordToolUsage: vi.fn(),
}));

describe('agent-tools-runtime-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('executeLLMCallWithFallback', () => {
    it('executes LLM call successfully', async () => {
      const { getOpenRouterClient } = await import('../server/services/openrouter-client');
      const mockClient = getOpenRouterClient();
      (mockClient.chat.completions.create as any).mockResolvedValue({
        choices: [{ message: { content: 'test response' } }],
      });

      const result = await executeLLMCallWithFallback(
        mockClient,
        'test-model',
        [{ role: 'user', content: 'test' }],
        [],
        0.5,
        1000,
        { agentName: 'test', modelFallback: 'fallback-model' },
        false,
      );

      expect(result.completion).toBeDefined();
      expect(result.usedFallback).toBe(false);
      expect(result.error).toBeUndefined();
    });

    it('triggers fallback on error', async () => {
      const { getOpenRouterClient } = await import('../server/services/openrouter-client');
      const mockClient = getOpenRouterClient();
      (mockClient.chat.completions.create as any).mockRejectedValue(new Error('API error'));

      const result = await executeLLMCallWithFallback(
        mockClient,
        'test-model',
        [{ role: 'user', content: 'test' }],
        [],
        0.5,
        1000,
        { agentName: 'test', modelFallback: 'fallback-model' },
        false,
      );

      expect(result.completion).toBeNull();
      expect(result.usedFallback).toBe(true);
      expect(result.error).toBe('FALLBACK_TRIGGERED');
    });

    it('returns error when fallback not available', async () => {
      const { getOpenRouterClient } = await import('../server/services/openrouter-client');
      const mockClient = getOpenRouterClient();
      (mockClient.chat.completions.create as any).mockRejectedValue(new Error('API error'));

      const result = await executeLLMCallWithFallback(
        mockClient,
        'test-model',
        [{ role: 'user', content: 'test' }],
        [],
        0.5,
        1000,
        { agentName: 'test', modelFallback: null },
        false,
      );

      expect(result.completion).toBeNull();
      expect(result.usedFallback).toBe(false);
      expect(result.error).toBe('API error');
    });
  });

  describe('executeToolCallsInParallel', () => {
    it('executes tool calls in parallel', async () => {
      const { executeToolForAgent } = await import('../server/services/agent-tools-registry');
      (executeToolForAgent as any).mockResolvedValue({ ok: true, data: 'result' });

      const toolCalls = [
        {
          type: 'function',
          function: { name: 'test_tool', arguments: '{"arg": "value"}' },
        },
      ];

      const results = await executeToolCallsInParallel(toolCalls, 0, {
        demandId: 123,
      });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('test_tool');
      expect(results[0].result.ok).toBe(true);
    });

    it('handles JSON parse errors gracefully', async () => {
      const { executeToolForAgent } = await import('../server/services/agent-tools-registry');
      (executeToolForAgent as any).mockResolvedValue({ ok: true, data: 'result' });

      const toolCalls = [
        {
          type: 'function',
          function: { name: 'test_tool', arguments: 'invalid json' },
        },
      ];

      const results = await executeToolCallsInParallel(toolCalls, 0, {
        demandId: 123,
      });

      expect(results).toHaveLength(1);
      expect(results[0].args).toEqual({ __raw: 'invalid json' });
    });
  });

  describe('executeFinalLLMCall', () => {
    it('executes final LLM call successfully', async () => {
      const { getOpenRouterClient } = await import('../server/services/openrouter-client');
      const mockClient = getOpenRouterClient();
      (mockClient.chat.completions.create as any).mockResolvedValue({
        choices: [{ message: { content: 'final response' } }],
      });

      const result = await executeFinalLLMCall(
        mockClient,
        'test-model',
        [{ role: 'user', content: 'test' }],
        0.5,
        1000,
        'test-agent',
      );

      expect(result.text).toBe('final response');
      expect(result.error).toBe(false);
    });

    it('handles errors gracefully', async () => {
      const { getOpenRouterClient } = await import('../server/services/openrouter-client');
      const mockClient = getOpenRouterClient();
      (mockClient.chat.completions.create as any).mockRejectedValue(new Error('API error'));

      const result = await executeFinalLLMCall(
        mockClient,
        'test-model',
        [{ role: 'user', content: 'test' }],
        0.5,
        1000,
        'test-agent',
      );

      expect(result.text).toBe('');
      expect(result.error).toBe(true);
    });
  });
});
