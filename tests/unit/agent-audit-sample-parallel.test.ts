import { describe, it, expect } from 'vitest';
import { runSingleAudit, aggregateAllSettledResults } from '../../scripts/agent-audit-sample';

/**
 * Spec 10137: testa paralelização fan-out com Promise.allSettled em agent-audit-sample.ts.
 */
describe('agent-audit-sample paralelização (spec 10137)', () => {
  describe('runSingleAudit', () => {
    it('produz samples com runId correto para runIndex 0', async () => {
      const samples = await runSingleAudit(0);
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.every((s) => s.runId === 'agent_audit_run_1')).toBe(true);
    });

    it('produz samples com runId correto para runIndex 4', async () => {
      const samples = await runSingleAudit(4);
      expect(samples.every((s) => s.runId === 'agent_audit_run_5')).toBe(true);
    });

    it('cada run produz um sample por agente selecionado', async () => {
      const samples = await runSingleAudit(0);
      // Deve ter pelo menos 1 sample (depende dos agentes configurados em agents/).
      expect(samples.length).toBeGreaterThanOrEqual(1);
      // Todos os samples devem ter agentName não-vazio.
      expect(samples.every((s) => s.agentName.length > 0)).toBe(true);
    });
  });

  describe('aggregateAllSettledResults', () => {
    it('agrega resultados fulfilled preservando samples', () => {
      const mockSamples = [
        {
          runId: 'run_1',
          agentName: 'a',
          roundIndex: 0,
          promptContext: {} as never,
          output: 'x',
          metrics: {} as never,
          uxSignature: {} as never,
        },
      ];
      const results: PromiseSettledResult<typeof mockSamples>[] = [
        { status: 'fulfilled', value: mockSamples },
        { status: 'fulfilled', value: mockSamples },
      ];
      const agg = aggregateAllSettledResults(results);
      expect(agg.runsSucceeded).toBe(2);
      expect(agg.runsFailed).toBe(0);
      expect(agg.samples.length).toBe(2);
      expect(agg.errors).toEqual([]);
    });

    it('preserva resultados de runs que passaram quando uma falha', () => {
      const mockSamples = [
        {
          runId: 'run_1',
          agentName: 'a',
          roundIndex: 0,
          promptContext: {} as never,
          output: 'x',
          metrics: {} as never,
          uxSignature: {} as never,
        },
      ];
      const results: PromiseSettledResult<typeof mockSamples>[] = [
        { status: 'fulfilled', value: mockSamples },
        { status: 'rejected', reason: new Error('boom') },
        { status: 'fulfilled', value: mockSamples },
      ];
      const agg = aggregateAllSettledResults(results);
      expect(agg.runsSucceeded).toBe(2);
      expect(agg.runsFailed).toBe(1);
      expect(agg.samples.length).toBe(2);
      expect(agg.errors).toHaveLength(1);
      expect(agg.errors[0]).toContain('boom');
      expect(agg.errors[0]).toContain('run_2');
    });

    it('lida com todas as runs falhando', () => {
      const results: PromiseSettledResult<never[]>[] = [
        { status: 'rejected', reason: 'fail1' },
        { status: 'rejected', reason: new Error('fail2') },
      ];
      const agg = aggregateAllSettledResults(results);
      expect(agg.runsSucceeded).toBe(0);
      expect(agg.runsFailed).toBe(2);
      expect(agg.samples).toEqual([]);
      expect(agg.errors).toHaveLength(2);
    });
  });

  describe('fan-out com Promise.allSettled', () => {
    it('5 runs paralelas produzem 5x os samples de uma run', async () => {
      const singleRun = await runSingleAudit(0);
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) => runSingleAudit(i)),
      );
      const agg = aggregateAllSettledResults(results);
      expect(agg.runsSucceeded).toBe(5);
      expect(agg.runsFailed).toBe(0);
      expect(agg.samples.length).toBe(singleRun.length * 5);
    });

    it('uma run rejeitada não crasha a agregação', async () => {
      // Mistura runs reais com uma run que sempre falha.
      const failingRun = async (): Promise<never[]> => {
        throw new Error('simulated failure');
      };
      const results = await Promise.allSettled([
        runSingleAudit(0),
        failingRun(),
        runSingleAudit(2),
      ]);
      const agg = aggregateAllSettledResults(results);
      expect(agg.runsSucceeded).toBe(2);
      expect(agg.runsFailed).toBe(1);
      expect(agg.errors).toHaveLength(1);
      expect(agg.errors[0]).toContain('simulated failure');
    });
  });
});
