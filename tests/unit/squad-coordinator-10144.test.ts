import { describe, expect, it, vi, beforeEach } from 'vitest';

const agentOrchestratorMock = vi.hoisted(() => ({
  createOrchestrationPlan: vi.fn(),
}));

vi.mock('../../server/cognitive-core/agent-orchestrator', () => ({
  agentOrchestrator: agentOrchestratorMock,
}));

vi.mock('../../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../server/services/context-builder', () => ({
  contextBuilder: {
    clearEvolvingContext: vi.fn(),
    buildContext: vi.fn(() => 'base context'),
    setExternalContext: vi.fn(),
    setRealityConstraints: vi.fn(),
    getRealityConstraintsText: vi.fn(() => ''),
    capContext: vi.fn((input: string) => input),
  },
}));

vi.mock('../../server/services/refinement-rag', () => ({
  refinementRAGService: {
    ingestFromDocuments: vi.fn(),
    buildContext: vi.fn(),
  },
}));

vi.mock('../../server/services/domain-knowledge-rag', () => ({
  domainKnowledgeRAGService: {
    buildContext: vi.fn(),
  },
}));

vi.mock('../../server/repositories/demand-repository', () => ({
  demandRepository: {
    findById: vi.fn(),
    findByIdOrNull: vi.fn(),
    updateChat: vi.fn(),
    updateStatus: vi.fn(),
    // O gate factual persiste o veredito SEMPRE (inclusive `passed`) e o erro
    // propaga de propósito — sem este mock o teste quebra, que é o sinal
    // correto: refinamento sem gate gravado não pode seguir como aprovado.
    update: vi.fn().mockResolvedValue(undefined),
  },
}));

import { SquadCoordinator } from '../../server/services/ai-squad/squad-coordinator';
import { demandRepository } from '../../server/repositories/demand-repository';

describe('SquadCoordinator #10144 — constraints chegam com squad preenchida', () => {
  function buildDemand(overrides?: Record<string, unknown>) {
    return {
      id: 42,
      title: 'Adicionar autenticação OAuth2',
      description: 'Implementar login via OAuth2 com scopes mínimos.',
      type: 'security',
      status: 'pending',
      priority: 'alta',
      domain: 'padrao',
      goLiveMode: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function buildMockParent() {
    return {
      agentConfigs: {
        product_owner: { system_prompt: 'PO', description: 'Product Owner' },
        security_specialist: {
          system_prompt: 'Security',
          description: 'Especialista de segurança',
        },
      },
      realityBasedRefinement: {
        getConstraintsForDemandType: vi.fn(async (type: string) => ({
          demandType: type,
          canonicalDemandType: type,
          maturityLevel: 'MVP',
          capabilities: {},
          stack: {},
          allowedTechnologies: ['TypeScript', 'Node.js'],
          forbiddenTechnologies: ['kubernetes', 'microservices'],
          maxEffortDays: 10,
          minROI: '3:1',
          outputType: 'standard refinement',
          typeRequirements: ['Threat and vulnerability assessment', 'Security acceptance criteria'],
        })),
      },
      sendSSEUpdate: vi.fn(),
    } as any;
  }

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(demandRepository.findById).mockResolvedValue(buildDemand() as any);

    agentOrchestratorMock.createOrchestrationPlan.mockResolvedValue({
      classification: {
        category: 'technical',
        confidence: 0.9,
        recommendedAgents: ['security_specialist', 'tech_lead'],
      },
    });
  });

  it('injeta forbiddenTechnologies e typeRequirements mesmo quando agentIds já está preenchido', async () => {
    const parent = buildMockParent();
    const coordinator = new SquadCoordinator(parent);

    const runRoundTableSpy = vi
      .spyOn(coordinator['roundtableOrchestrator'], 'runRoundTable')
      .mockResolvedValue({
        rounds: [],
        consolidation: {},
        totalDivergences: 0,
        agentsFailed: [],
        graph: undefined,
        escalations: [],
      } as any);

    const config = {
      agentIds: ['product_owner', 'tech_lead'],
      maxRounds: 3,
      refinementLevel: 2,
    };

    await coordinator.processRoundtable(42, config, undefined, { skipExtraction: true } as any);

    expect(runRoundTableSpy).toHaveBeenCalledOnce();
    const [, effectiveConfig, internalContext] = runRoundTableSpy.mock.calls[0] as any;

    // C1: forbiddenTechnologies e typeRequirements aparecem no contexto
    expect(internalContext).toContain('kubernetes');
    expect(internalContext).toContain('Threat and vulnerability assessment');
    expect(internalContext).toContain('Security acceptance criteria');

    // H1/A2: security_specialist entra na squad mesmo com agentIds preenchido
    expect(effectiveConfig.agentIds).toContain('security_specialist');
    expect(effectiveConfig.agentIds).toContain('product_owner');
    expect(effectiveConfig.agentIds).toContain('tech_lead');

    // Squad original mantém a ordem e prioridade
    expect(effectiveConfig.agentIds.indexOf('product_owner')).toBeLessThan(
      effectiveConfig.agentIds.indexOf('security_specialist'),
    );

    // maxRounds/respeita config original quando preenchida
    expect(effectiveConfig.maxRounds).toBe(3);
    expect(effectiveConfig.refinementLevel).toBe(2);
  });
});
