import { describe, it, expect, beforeEach } from 'vitest';
import { RoundtableOrchestrator } from '../../server/services/ai-squad/roundtable-orchestrator';
import { consolidationTypeRequirementsMissingTotal } from '../../server/metrics';
import type { RefinementOutput } from '../../server/orchestration-contracts/roundtable';

/**
 * Avaliação de fluxo de agentes (2026-07-26, A-2): valida o único ponto do
 * caminho vivo (roundtable) que checa se a consolidação cobre as seções
 * obrigatórias do tipo de demanda antes de virar o artifact do handoff.
 * Antes deste teste, `validateTypeRequirementsInConsolidation` não tinha
 * cobertura — e o warning que ela emite não incrementava nenhum contador.
 */
describe('RoundtableOrchestrator — validação de seções obrigatórias (A-2)', () => {
  let orchestrator: RoundtableOrchestrator;

  beforeEach(() => {
    const fakeParent = {
      agentConfigs: {},
    } as unknown as Parameters<typeof RoundtableOrchestrator.prototype.constructor>[0];
    orchestrator = new RoundtableOrchestrator(fakeParent);
  });

  function buildConsolidation(overrides: Partial<RefinementOutput> = {}): RefinementOutput {
    return {
      problema: 'Problema descrito',
      objetivo: 'Objetivo claro',
      escopo: 'Escopo definido',
      criterios_de_aceite: ['Critério 1'],
      riscos: [],
      dependencias: [],
      divergencias: [],
      consolidacao: 'Síntese final',
      ...overrides,
    };
  }

  it('não incrementa o contador quando não há typeRequirements', async () => {
    const before = (await consolidationTypeRequirementsMissingTotal.get()).values.find(
      (v) => v.labels.demand_type === 'sem_requisitos_teste',
    );

    (orchestrator as any).validateTypeRequirementsInConsolidation(
      1,
      'sem_requisitos_teste',
      buildConsolidation(),
      undefined,
    );

    const after = (await consolidationTypeRequirementsMissingTotal.get()).values.find(
      (v) => v.labels.demand_type === 'sem_requisitos_teste',
    );
    expect(after?.value ?? 0).toBe(before?.value ?? 0);
  });

  it('incrementa o contador quando uma seção obrigatória não aparece no texto', async () => {
    const before =
      (await consolidationTypeRequirementsMissingTotal.get()).values.find(
        (v) => v.labels.demand_type === 'security',
      )?.value ?? 0;

    (orchestrator as any).validateTypeRequirementsInConsolidation(
      2,
      'security',
      buildConsolidation(),
      ['Seção Segurança, Compliance e Riscos de Dados'],
    );

    const after =
      (await consolidationTypeRequirementsMissingTotal.get()).values.find(
        (v) => v.labels.demand_type === 'security',
      )?.value ?? 0;
    expect(after).toBe(before + 1);
  });

  it('não incrementa quando a seção obrigatória já aparece no texto (case-insensitive)', async () => {
    const before =
      (await consolidationTypeRequirementsMissingTotal.get()).values.find(
        (v) => v.labels.demand_type === 'security_ok',
      )?.value ?? 0;

    (orchestrator as any).validateTypeRequirementsInConsolidation(
      3,
      'security_ok',
      buildConsolidation({
        escopo: 'Inclui Seção Segurança, Compliance e Riscos de Dados detalhada.',
      }),
      ['Seção Segurança, Compliance e Riscos de Dados'],
    );

    const after =
      (await consolidationTypeRequirementsMissingTotal.get()).values.find(
        (v) => v.labels.demand_type === 'security_ok',
      )?.value ?? 0;
    expect(after).toBe(before);
  });
});
