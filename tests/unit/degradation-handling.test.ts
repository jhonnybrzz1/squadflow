/**
 * Testes de integração para degradações silenciosas
 * Spec 10122: discovery-plugin, demand-classifier, agent-orchestrator
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const loggerError = vi.fn();
const metricInc = vi.fn();
const metricLabels = vi.fn().mockReturnValue({ inc: metricInc });

vi.mock('../../server/utils/logger', () => ({
  logger: {
    error: loggerError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../server/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/metrics')>();
  return {
    ...actual,
    aiModelFailureTotal: { labels: metricLabels },
    featureFlagIoErrorTotal: { labels: metricLabels },
    squadGraphFlagDegradedTotal: { labels: metricLabels },
    register: { registerMetric: vi.fn() },
  };
});

vi.mock('../../server/db', () => ({
  isPostgres: false,
  db: {
    query: {
      demands: { findFirst: vi.fn() },
    },
  },
}));

vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: {
    update: vi.fn().mockResolvedValue(true),
    findById: vi.fn().mockResolvedValue({
      id: 1,
      title: 'Test',
      description: 'Test',
      type: 'feature',
    }),
  },
}));

vi.mock('../../server/services/openai-ai', () => ({
  openAIService: {
    generateChatCompletion: vi.fn(),
  },
}));

const fsReadFileImpl = vi.hoisted(() => ({
  current: undefined as ((...args: any[]) => any) | undefined,
}));
vi.mock('fs', () => ({
  readFileSync: vi.fn((..._args: any[]) => {
    if (fsReadFileImpl.current) return fsReadFileImpl.current(..._args);
    return '';
  }),
  existsSync: vi.fn((..._args: any[]) => {
    if (fsReadFileImpl.current) return true;
    return false;
  }),
}));

describe('Degradações silenciosas (Spec 10122)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('demand-classifier.ts:532 — erro de IO/permissão em feature flags', () => {
    it('loga erro estruturado, incrementa feature_flag_io_error_total e desliga híbrido (fail-closed)', async () => {
      fsReadFileImpl.current = () => {
        const err = new Error('EACCES: permission denied') as any;
        err.code = 'EACCES';
        throw err;
      };

      const { demandClassifier } = await import('../../server/cognitive-core/demand-classifier');
      const classification = await demandClassifier.classifyDemand({
        id: 99,
        title: 'Test',
        description: 'Test description',
        type: 'feature',
      } as any);

      expect(classification).toBeDefined();
      expect(classification.category).toBeDefined();

      const ioErrorCalls = loggerError.mock.calls.filter((call) =>
        String(call[1]?.context?.flag_path).includes('feature-flags.json'),
      );
      expect(ioErrorCalls.length).toBeGreaterThanOrEqual(1);

      const ioMetricCalls = metricLabels.mock.calls.filter(
        (call) => call[0]?.error_code === 'EACCES',
      );
      expect(ioMetricCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('agent-orchestrator.ts:161 — falha de leitura da flag squadGraphEnabled', () => {
    it('loga erro estruturado, incrementa squad_graph_flag_degraded_total e aplica fail-closed', async () => {
      const { featureFlags } = await import('../../server/services/feature-flags');
      const getFlagsSpy = vi.spyOn(featureFlags, 'getFlags').mockImplementation(() => {
        throw new Error('Simulated flag read failure');
      });

      const { agentOrchestrator } = await import('../../server/cognitive-core/agent-orchestrator');

      const plan = await agentOrchestrator.createOrchestrationPlan(1);

      expect(plan).toBeDefined();
      expect(plan.graph).toBeUndefined();

      const flagErrorCalls = loggerError.mock.calls.filter(
        (call) => call[1]?.context?.flag_name === 'squadGraphEnabled',
      );
      expect(flagErrorCalls.length).toBeGreaterThanOrEqual(1);
      expect(flagErrorCalls[0][1].context.fallback_action).toBe('fail_closed');

      const flagMetricCalls = metricLabels.mock.calls.filter(
        (call) => call[0]?.flag_name === 'squadGraphEnabled',
      );
      expect(flagMetricCalls.length).toBeGreaterThanOrEqual(1);

      getFlagsSpy.mockRestore();
    });
  });
});
