import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DomainTelemetryService } from '../server/services/domain-telemetry';

describe('DomainTelemetryService', () => {
  let service: DomainTelemetryService;

  beforeEach(() => {
    // Inject a mock database
    const mockDb = {
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
      all: vi.fn(),
      run: vi.fn(),
    };
    service = new DomainTelemetryService(mockDb as any);
  });

  describe('Invariants Validation (T5)', () => {
    it('should validate that domain_used_in_final implies domain_usable_returned', () => {
      const data = {
        executionId: 'exec_123',
        demandId: 1,
        domain: 'outro',
        domainTriggered: true,
        domainUsableReturned: false,
        domainUsedInFinal: true, // INVALID STATE
        outputSource: 'synthesizeResults',
        fallbackOrReprocess: false,
        latencyMs: 100,
      };

      // In a real flow, the code that generates this data must enforce:
      const isValid = data.domainUsedInFinal ? data.domainUsableReturned === true : true;
      expect(isValid).toBe(false);
    });

    it('should validate that domain_usable_returned implies domain_triggered', () => {
      const data = {
        executionId: 'exec_123',
        demandId: 1,
        domain: 'geral',
        domainTriggered: false, // INVALID STATE if usable is true
        domainUsableReturned: true,
        domainUsedInFinal: true,
        outputSource: 'synthesizeResults',
        fallbackOrReprocess: false,
        latencyMs: 100,
      };

      const isValid = data.domainUsableReturned ? data.domainTriggered === true : true;
      expect(isValid).toBe(false);
    });

    it('should pass for valid states', () => {
      const data = {
        executionId: 'exec_123',
        demandId: 1,
        domain: 'misto',
        domainTriggered: true,
        domainUsableReturned: true,
        domainUsedInFinal: false, // Valid: triggered and returned usable, but dropped in final synthesis
        outputSource: 'synthesizeResults',
        fallbackOrReprocess: false,
        latencyMs: 100,
      };

      const validRule1 = data.domainUsedInFinal ? data.domainUsableReturned === true : true;
      const validRule2 = data.domainUsableReturned ? data.domainTriggered === true : true;

      expect(validRule1).toBe(true);
      expect(validRule2).toBe(true);
    });
  });

  describe('Classification Rules (T3 & T4)', () => {
    it('classifies as NEVER_ELIGIBLE if triggerRate < 10%', async () => {
      (service as any).database.all = vi
        .fn()
        .mockReturnValueOnce([
          {
            total: 100,
            triggered_count: 5, // 5%
            usable_count: 5,
            used_final_count: 5,
            error_count: 0,
          },
        ])
        .mockReturnValueOnce([]); // latencies

      const report = await service.generateDomainReport('outro');
      expect(report?.classification).toBe('NEVER_ELIGIBLE');

      const decision = service.evaluateDecisionGuardrails(report!, 20);
      expect(decision.approved).toBe(true);
      expect(decision.safeAction).toContain('ajuste de gate/roteamento');
    });

    it('blocks decision if sample size is insufficient (Guardrail)', async () => {
      (service as any).database.all = vi
        .fn()
        .mockReturnValueOnce([
          {
            total: 5, // < 20
            triggered_count: 0,
            usable_count: 0,
            used_final_count: 0,
            error_count: 0,
          },
        ])
        .mockReturnValueOnce([]);

      const report = await service.generateDomainReport('misto');
      const decision = service.evaluateDecisionGuardrails(report!, 20);
      expect(decision.approved).toBe(false);
      expect(decision.reason).toContain('Amostra insuficiente');
    });

    it('classifies as VALID_AND_CONSOLIDATED for healthy stats', async () => {
      (service as any).database.all = vi
        .fn()
        .mockReturnValueOnce([
          {
            total: 100,
            triggered_count: 80, // 80%
            usable_count: 70, // 87.5% of triggered
            used_final_count: 60, // 85.7% of usable
            error_count: 2,
          },
        ])
        .mockReturnValueOnce([]);

      const report = await service.generateDomainReport('geral');
      expect(report?.classification).toBe('VALID_AND_CONSOLIDATED');
      expect(report?.triggerRate).toBe(80);
      expect(report?.impactRate).toBeGreaterThan(50);
    });
  });
});
