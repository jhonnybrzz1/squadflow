/**
 * Regressão: shared/demand-types.ts referencia frameworks nunca implementados
 * (threat-modeling, privacy-by-design, incremental-refactoring,
 * architecture-decision-record) para os tipos security/refactoring/infraestrutura.
 * Antes do fix, `determinePrimaryFramework`/`determineSecondaryFrameworks`
 * faziam `as FrameworkType` sem validar, e o lookup em `frameworkMetrics`
 * falhava silenciosamente (`successMetrics: undefined`). Achado convergente
 * em 2 das auditorias de 2026-07-21.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../../server/utils/logger', () => ({ logger: loggerMocks }));

const metricMocks = vi.hoisted(() => ({
  frameworkFallbackInc: vi.fn(),
  frameworkFallbackLabels: vi.fn().mockReturnThis(),
}));
vi.mock('../../server/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/metrics')>();
  return {
    ...actual,
    frameworkFallbackTotal: {
      labels: metricMocks.frameworkFallbackLabels.mockReturnValue({
        inc: metricMocks.frameworkFallbackInc,
      }),
    },
  };
});

const { generateResponse } = vi.hoisted(() => ({ generateResponse: vi.fn() }));
vi.mock('../../server/services/openai-ai', () => ({
  openAIService: { generateResponse },
}));

vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: { findByIdOrNull: vi.fn(), update: vi.fn() },
}));

import { FrameworkManager } from '../../server/frameworks/framework-manager';
import type { Demand } from '@shared/schema';

function buildDemand(type: string): Demand {
  return {
    id: 1,
    title: 'Demanda de teste',
    description: 'desc',
    type,
    priority: 'alta',
  } as unknown as Demand;
}

describe('FrameworkManager — fallback para frameworks fantasma', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(['security', 'refactoring', 'infraestrutura'])(
    'demanda tipo "%s" recomenda auto-suggest (não undefined), loga e incrementa métrica de fallback',
    async (demandType) => {
      generateResponse.mockRejectedValue(new Error('LLM indisponível no teste'));

      const manager = new FrameworkManager();
      await manager.initialize();

      const recommendation = await manager.recommendFramework(buildDemand(demandType));

      expect(recommendation.recommendedFramework).toBe('auto-suggest');
      expect(recommendation.successMetrics).toBeDefined();
      expect(loggerMocks.warn).toHaveBeenCalledWith(
        expect.stringMatching(/não está (registrado|implementado)|registrado como stub/),
        expect.objectContaining({ context: expect.objectContaining({ demandType }) }),
      );
      expect(metricMocks.frameworkFallbackLabels).toHaveBeenCalled();
      expect(metricMocks.frameworkFallbackInc).toHaveBeenCalled();
    },
  );

  it('demanda tipo "descoberta" (framework real) não aciona o fallback', async () => {
    generateResponse.mockRejectedValue(new Error('LLM indisponível no teste'));

    const manager = new FrameworkManager();
    await manager.initialize();

    const recommendation = await manager.recommendFramework(buildDemand('discovery'));

    expect(recommendation.recommendedFramework).not.toBe('auto-suggest');
    expect(
      loggerMocks.warn.mock.calls.some((call) => String(call[0]).includes('não está implementado')),
    ).toBe(false);
  });
});
