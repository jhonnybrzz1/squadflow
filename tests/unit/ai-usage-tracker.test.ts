import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AIUsageTracker,
  normalizeAgentId,
  normalizeStage,
} from '../../server/services/ai-usage-tracker';

vi.mock('../../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function makeRecord(partial: Partial<ReturnType<AIUsageTracker['getAllRecords']>[number]> = {}) {
  return {
    timestamp: new Date().toISOString(),
    operation: 'chat_completion',
    model: 'openai:gpt-4o',
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    estimatedCostUsd: 0.0025,
    cacheHit: false,
    estimatedTokensSaved: 0,
    estimatedCostSavedUsd: null,
    latencyMs: 100,
    ...partial,
  };
}

describe('ai-usage-tracker', () => {
  let tracker: AIUsageTracker;

  beforeEach(() => {
    tracker = new AIUsageTracker();
    vi.clearAllMocks();
  });

  describe('normalizeAgentId', () => {
    it('aceita agentId válido', () => {
      const result = normalizeAgentId('agent:cognitive-core');
      expect(result.agentId).toBe('agent:cognitive-core');
      expect(result.valid).toBe(true);
    });

    it('rejeita agentId sem prefixo e fallback para unlabeled', () => {
      const result = normalizeAgentId('INVALID');
      expect(result.agentId).toBe('agent:unlabeled');
      expect(result.valid).toBe(false);
    });

    it('fallback para unlabeled quando ausente', () => {
      const result = normalizeAgentId(undefined);
      expect(result.agentId).toBe('agent:unlabeled');
      expect(result.valid).toBe(false);
    });
  });

  describe('normalizeStage', () => {
    it('aceita stage válido', () => {
      const result = normalizeStage('enrichment');
      expect(result.stage).toBe('enrichment');
      expect(result.valid).toBe(true);
    });

    it('rejeita stage com maiúsculas e fallback', () => {
      const result = normalizeStage('Enrichment');
      expect(result.stage).toBe('unlabeled');
      expect(result.valid).toBe(false);
    });

    it('fallback para unlabeled quando ausente', () => {
      const result = normalizeStage(undefined);
      expect(result.stage).toBe('unlabeled');
      expect(result.valid).toBe(false);
    });
  });

  describe('record', () => {
    it('normaliza agentId e stage ao registrar', () => {
      tracker.record(makeRecord({ agentId: 'INVALID', stage: 'Bad Stage' }));
      const records = tracker.getAllRecords();
      expect(records[0].agentId).toBe('agent:unlabeled');
      expect(records[0].stage).toBe('unlabeled');
    });

    it('preserva agentId e stage válidos', () => {
      tracker.record(makeRecord({ agentId: 'agent:cognitive-core', stage: 'enrichment' }));
      const records = tracker.getAllRecords();
      expect(records[0].agentId).toBe('agent:cognitive-core');
      expect(records[0].stage).toBe('enrichment');
    });

    it('registra requestCount implícito como 1 por registro', () => {
      tracker.record(makeRecord({ agentId: 'agent:cognitive-core' }));
      const summary = tracker.getSummary();
      expect(summary.byAgent['agent:cognitive-core'].requestCount).toBe(1);
    });
  });

  describe('getSummary', () => {
    it('agrega por agente e etapa', () => {
      tracker.record(
        makeRecord({
          agentId: 'agent:cognitive-core',
          stage: 'enrichment',
          estimatedCostUsd: 0.001,
        }),
      );
      tracker.record(
        makeRecord({
          agentId: 'agent:cognitive-core',
          stage: 'enrichment',
          estimatedCostUsd: 0.002,
        }),
      );
      tracker.record(
        makeRecord({
          agentId: 'agent:product-manager',
          stage: 'drafting',
          estimatedCostUsd: 0.003,
        }),
      );

      const summary = tracker.getSummary();

      expect(summary.byAgent['agent:cognitive-core'].requestCount).toBe(2);
      expect(summary.byAgent['agent:cognitive-core'].estimatedCostUsd).toBe(0.003);
      expect(summary.byAgent['agent:product-manager'].requestCount).toBe(1);
      expect(summary.byStage['enrichment'].requestCount).toBe(2);
      expect(summary.byStage['drafting'].requestCount).toBe(1);
    });

    it('coloca registros antigos sem agentId em agent:unlabeled', () => {
      tracker.record(makeRecord({})); // sem agentId/stage
      const summary = tracker.getSummary();
      expect(summary.byAgent['agent:unlabeled'].requestCount).toBe(1);
      expect(summary.byStage['unlabeled'].requestCount).toBe(1);
    });

    it('calcula custo por mil requisições por agente', () => {
      tracker.record(makeRecord({ agentId: 'agent:cognitive-core', estimatedCostUsd: 0.01 }));
      tracker.record(makeRecord({ agentId: 'agent:cognitive-core', estimatedCostUsd: 0.01 }));

      const summary = tracker.getSummary();
      const agent = summary.byAgent['agent:cognitive-core'];
      const costPerThousand = agent.estimatedCostUsd / (agent.requestCount / 1000);
      expect(costPerThousand).toBe(10);
    });
  });
});
