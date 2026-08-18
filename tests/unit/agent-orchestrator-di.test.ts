import { describe, it, expect, vi } from 'vitest';
import { AgentOrchestrator } from '../../server/cognitive-core/agent-orchestrator';
import type { Demand } from '@shared/schema';
import type { DemandClassification } from '../../server/orchestration-contracts';

/**
 * Avaliação de fluxo de agentes (2026-07-26, C-1): antes da injeção de
 * dependências, testar `AgentOrchestrator` exigia `vi.mock(...)` no nível do
 * módulo para cada um dos 6 serviços stateful que ele importava direto
 * (repositório, classificador, execução de agente, contexto, flags,
 * eventos). Este teste mostra o ganho: cada dependência é uma fake passada
 * no construtor, sem tocar no sistema de módulos.
 */
describe('AgentOrchestrator — injeção de dependências (C-1)', () => {
  function buildFakeDemand(): Demand {
    return { id: 1, title: 'Teste', description: 'desc', type: 'bug' } as Demand;
  }

  function buildFakeClassification(): DemandClassification {
    return {
      category: 'technical',
      criteria: {
        ambiguity: 10,
        interpretationRisk: 10,
        depthRequired: 10,
        complexity: 10,
        urgency: 10,
      },
      confidence: 0.9,
      recommendedAgents: ['product_owner', 'tech_lead', 'qa'],
      notes: '',
      personalReadiness: { score: 100, gaps: [] },
    } as unknown as DemandClassification;
  }

  it('cria um plano de orquestração usando só as fakes injetadas, sem vi.mock de módulo', async () => {
    const demand = buildFakeDemand();
    const classification = buildFakeClassification();

    const fakeDeps = {
      demandRepository: {
        findById: vi.fn().mockResolvedValue(demand),
        update: vi.fn(),
        updateStatus: vi.fn(),
        markAsError: vi.fn(),
      },
      demandClassifier: {
        classifyDemand: vi.fn().mockResolvedValue(classification),
      },
      agentInteractionService: {
        executeAgent: vi.fn(),
      },
      contextBuilder: {
        validateAgentResponse: vi.fn(),
        recordVerifiedEvidence: vi.fn(),
      },
      featureFlags: {
        getFlags: vi.fn().mockReturnValue({ squadGraphEnabled: false }),
      },
      eventBus: {
        publish: vi.fn(),
      },
    };

    const orchestrator = new AgentOrchestrator(fakeDeps as any);
    const plan = await orchestrator.createOrchestrationPlan(demand.id);

    expect(fakeDeps.demandRepository.findById).toHaveBeenCalledWith(demand.id);
    expect(fakeDeps.demandClassifier.classifyDemand).toHaveBeenCalledWith(demand);
    expect(plan.demandId).toBe(demand.id);
    expect(plan.agentExecutionOrder).toContain('product_owner');
    // squadGraphEnabled=false na fake → sem grafo, sem custo de instrumentação.
    expect(plan.graph).toBeUndefined();
  });
});
