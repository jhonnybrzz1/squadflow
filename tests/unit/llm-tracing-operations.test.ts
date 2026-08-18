/**
 * Testes unitários para llm-tracing-operations.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type FeatureFlags } from '../../server/services/feature-flags';
import {
  startTracing,
  endTracing,
  type TracingOptions,
} from '../../server/services/llm-tracing-operations';

// Mock dependencies
vi.mock('../../server/services/llm-tracing', () => ({
  llmTracingService: {
    startSpan: vi.fn(),
    endSpan: vi.fn(),
  },
}));

vi.mock('../../server/services/feature-flags', () => ({
  featureFlags: {
    getFlags: vi.fn(),
  },
}));

describe('llm-tracing-operations', () => {
  const mockOptions: TracingOptions = {
    operation: 'test-operation',
    model: 'gpt-4',
    provider: 'openai',
    agentName: 'test-agent',
    demandId: 1,
    requestId: 'test-123',
    input: {
      messageCount: 2,
      lastUserMessage: 'test message',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('startTracing', () => {
    it('deve iniciar span quando feature flag habilitada', async () => {
      const { featureFlags } = await import('../../server/services/feature-flags');
      const { llmTracingService } = await import('../../server/services/llm-tracing');
      vi.mocked(featureFlags.getFlags).mockReturnValue({
        enableLlmTracing: true,
      } as unknown as FeatureFlags);
      vi.mocked(llmTracingService.startSpan).mockReturnValue({ id: 'span-1' });

      const result = startTracing(mockOptions);

      expect(result.enabled).toBe(true);
      expect(result.span).not.toBeNull();
      expect(llmTracingService.startSpan).toHaveBeenCalledWith({
        operation: mockOptions.operation,
        model: mockOptions.model,
        provider: mockOptions.provider,
        agentName: mockOptions.agentName,
        demandId: mockOptions.demandId,
        requestId: mockOptions.requestId,
        input: mockOptions.input,
      });
    });

    it('deve desabilitar tracing quando feature flag desabilitada', async () => {
      const { featureFlags } = await import('../../server/services/feature-flags');
      vi.mocked(featureFlags.getFlags).mockReturnValue({
        enableLlmTracing: false,
      } as unknown as FeatureFlags);

      const result = startTracing(mockOptions);

      expect(result.enabled).toBe(false);
      expect(result.span).toBeNull();
    });

    it('deve desabilitar tracing quando feature flag lançar erro', async () => {
      const { featureFlags } = await import('../../server/services/feature-flags');
      vi.mocked(featureFlags.getFlags).mockImplementation(() => {
        throw new Error('Feature flags error');
      });

      const result = startTracing(mockOptions);

      expect(result.enabled).toBe(false);
      expect(result.span).toBeNull();
    });
  });

  describe('endTracing', () => {
    it('deve finalizar span quando tracing habilitado', async () => {
      const { llmTracingService } = await import('../../server/services/llm-tracing');
      vi.mocked(llmTracingService.endSpan).mockReturnValue(undefined);

      const context = { span: { spanId: 'span-1' }, enabled: true };
      const result = {
        content: 'test response',
        modelUsed: 'gpt-4',
        provider: 'openai',
        usage: {
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
        },
        latencyMs: 100,
      };

      endTracing(context, result);

      expect(llmTracingService.endSpan).toHaveBeenCalledWith(
        context.span.spanId,
        expect.objectContaining({
          status: expect.any(String),
          output: expect.any(Object),
          tokenUsage: expect.any(Object),
        }),
      );
    });

    it('deve ignorar quando tracing desabilitado', async () => {
      const { llmTracingService } = await import('../../server/services/llm-tracing');
      vi.mocked(llmTracingService.endSpan).mockReturnValue(undefined);

      const context = { span: null, enabled: false };
      const result = {
        content: 'test response',
        modelUsed: 'gpt-4',
        provider: 'openai',
        latencyMs: 100,
      };

      endTracing(context, result);

      expect(llmTracingService.endSpan).not.toHaveBeenCalled();
    });

    it('deve incluir erro no resultado quando presente', async () => {
      const { llmTracingService } = await import('../../server/services/llm-tracing');
      vi.mocked(llmTracingService.endSpan).mockReturnValue(undefined);

      const context = { span: { spanId: 'span-1' }, enabled: true };
      const result = {
        content: 'test response',
        modelUsed: 'gpt-4',
        provider: 'openai',
        latencyMs: 100,
        error: 'Test error',
      };

      endTracing(context, result);

      expect(llmTracingService.endSpan).toHaveBeenCalledWith(
        context.span.spanId,
        expect.objectContaining({
          error: 'Test error',
        }),
      );
    });
  });
});
