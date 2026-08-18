import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentRouterService } from '../server/services/agent-router';
import { openAIService } from '../server/services/openai-ai';
import type { RefinementDecisionContext } from '@shared/schema';

describe('AgentRouterService', () => {
  let router: AgentRouterService;
  const AVAILABLE_AGENTS = [
    'product_owner',
    'qa',
    'tech_lead',
    'product_manager',
    'ux_designer',
    'ux',
    'data_analyst',
    'analista_de_dados',
    'scrum_master',
    'security_specialist',
    'architect',
    'financial_analyst',
  ];

  beforeEach(() => {
    router = new AgentRouterService({ run: () => {} } as any);
  });

  describe('Legacy decideAgentsForRefinement', () => {
    it('omits ux_designer for tech_task without ui impact', () => {
      const context: RefinementDecisionContext = {
        demandType: 'melhoria',
        taskType: 'tech_task',
        problemDefined: null,
        uiImpactKnown: false,
        acceptanceScope: 'technical',
        confidence: 'high',
      };

      const decision = router.decideAgentsForRefinement(context, AVAILABLE_AGENTS, false);

      expect(decision.shadowMode).toBe(false);
      expect(decision.actualOmitAgents).toContain('ux');
      expect(decision.actualIncludeAgents).not.toContain('ux');
    });

    it('keeps all agents for low confidence (fallback)', () => {
      const context: RefinementDecisionContext = {
        demandType: 'melhoria',
        taskType: 'tech_task',
        problemDefined: null,
        uiImpactKnown: false,
        acceptanceScope: 'mixed',
        confidence: 'low',
      };

      const decision = router.decideAgentsForRefinement(context, AVAILABLE_AGENTS, false);

      expect(decision.fallbackUsed).toBe(true);
      expect(decision.reasonCodes).toContain('fallback_low_confidence');
      // Low confidence keeps all agents (PRD: confidence < 0.6 → all agents)
      expect(decision.actualIncludeAgents).toHaveLength(AVAILABLE_AGENTS.length);
    });

    it('omits non-essential agents for defined bugs', () => {
      const context: RefinementDecisionContext = {
        demandType: 'bug',
        taskType: 'defined_bug',
        problemDefined: true,
        uiImpactKnown: false,
        acceptanceScope: 'technical',
        confidence: 'high',
      };

      const decision = router.decideAgentsForRefinement(context, AVAILABLE_AGENTS, false);

      expect(decision.actualOmitAgents).toContain('ux');
      expect(decision.actualOmitAgents).toContain('analista_de_dados');
      expect(decision.actualIncludeAgents).toContain('product_owner');
      expect(decision.actualIncludeAgents).toContain('qa');
      expect(decision.actualIncludeAgents).toContain('tech_lead');
    });

    it('includes all agents when in shadow mode', () => {
      const context: RefinementDecisionContext = {
        demandType: 'melhoria',
        taskType: 'tech_task',
        problemDefined: null,
        uiImpactKnown: false,
        acceptanceScope: 'technical',
        confidence: 'high',
      };

      const decision = router.decideAgentsForRefinement(context, AVAILABLE_AGENTS, true);

      expect(decision.shadowMode).toBe(true);
      expect(decision.proposedOmitAgents.length).toBeGreaterThan(0);
      expect(decision.actualOmitAgents.length).toBe(0);
      expect(decision.actualIncludeAgents).toHaveLength(AVAILABLE_AGENTS.length);
    });
  });

  describe('Smart classifyDemandForRouting', () => {
    it('classifies a technical demand via regex', async () => {
      const result = await router.classifyDemandForRouting(
        'Corrigir bug na API de autenticação',
        'O endpoint /api/auth/login retorna erro 500 quando o banco de dados está lento. Precisa refatorar a query SQL e adicionar cache.',
        'bug',
        AVAILABLE_AGENTS,
      );

      expect(result.category).toBe('technical');
      expect(result.confidence).toBeGreaterThanOrEqual(0.6);
      expect(result.method).toBe('regex');
      expect(result.selectedAgents).toContain('product_owner');
      expect(result.selectedAgents).toContain('tech_lead');
      expect(result.selectedAgents.length).toBeLessThan(AVAILABLE_AGENTS.length);
    });

    it('classifies a business demand via regex', async () => {
      const result = await router.classifyDemandForRouting(
        'Estratégia de crescimento de receita',
        'Precisamos definir uma estratégia de vendas para aumentar o ROI. Análise de mercado e conversão de clientes são prioritários.',
        'nova_funcionalidade',
        AVAILABLE_AGENTS,
      );

      expect(result.category).toBe('business');
      expect(result.confidence).toBeGreaterThanOrEqual(0.6);
      expect(result.method).toBe('regex');
      expect(result.selectedAgents).toContain('product_owner');
      expect(result.selectedAgents).toContain('product_manager');
    });

    it('classifies a creative/UX demand via regex', async () => {
      const result = await router.classifyDemandForRouting(
        'Redesign da interface de login',
        'Criar wireframe e protótipo para melhorar a usabilidade do fluxo de login. Incluir acessibilidade e novo layout.',
        'melhoria',
        AVAILABLE_AGENTS,
      );

      expect(result.category).toBe('creative');
      expect(result.confidence).toBeGreaterThanOrEqual(0.6);
      expect(result.selectedAgents).toContain('ux');
    });

    it('falls back to all agents for vague demands', async () => {
      // Mock LLM to fail, simulating no API key / unavailable LLM scenario
      const llmSpy = vi
        .spyOn(openAIService, 'generateChatCompletion')
        .mockRejectedValueOnce(new Error('LLM unavailable in test env'));

      const result = await router.classifyDemandForRouting(
        'Melhorar isso',
        'Precisa ficar melhor.',
        'melhoria',
        AVAILABLE_AGENTS,
      );

      // Vague demand: regex won't match, LLM mocked to fail → fallback
      expect(result.method).toBe('fallback');
      expect(result.selectedAgents).toHaveLength(AVAILABLE_AGENTS.length);
      expect(result.confidence).toBeLessThan(0.6);

      llmSpy.mockRestore();
    }, 30000);

    it('detects multidisciplinary demands (technical+creative)', async () => {
      // Determinístico (R-7): este input é ambíguo para o regex e às vezes
      // recorria ao LLM real, cuja latência estourava o timeout de 15s — era o
      // teste flaky exposto por `npm run gates`. O stub mantém a detecção
      // multidisciplinar sem chamada de rede.
      const llmSpy = vi
        .spyOn(openAIService, 'generateChatCompletion')
        .mockResolvedValue(
          '{"category":"product","confidence":0.85,"selectedAgents":["product_owner","tech_lead","ux"],"reasoning":"técnico + criativo"}',
        );

      const result = await router.classifyDemandForRouting(
        'Nova funcionalidade com API e design',
        'Criar endpoint backend para upload de imagens com nova interface UI. Precisa de wireframe, design responsivo, API REST, e query SQL otimizada.',
        'nova_funcionalidade',
        AVAILABLE_AGENTS,
      );

      // Detecta múltiplas categorias — via regex 'mixed' ou via LLM (stub acima).
      expect(result.selectedAgents.length).toBeGreaterThanOrEqual(2);
      expect(result.selectedAgents).toContain('product_owner');

      llmSpy.mockRestore();
    });

    it('always includes product_owner in selected agents', async () => {
      const result = await router.classifyDemandForRouting(
        'Análise de dados de vendas',
        'Preciso de um relatório dashboard com métricas de analytics e KPIs.',
        'melhoria',
        AVAILABLE_AGENTS,
      );

      expect(result.selectedAgents).toContain('product_owner');
    });

    it('selected agents are a subset of available agents', async () => {
      const result = await router.classifyDemandForRouting(
        'Corrigir performance do backend',
        'A API está lenta, precisa otimizar queries e deploy.',
        'bug',
        AVAILABLE_AGENTS,
      );

      for (const agent of result.selectedAgents) {
        expect(AVAILABLE_AGENTS).toContain(agent);
      }
    });

    it('preserves specialists required by type and domain', async () => {
      const llmSpy = vi
        .spyOn(openAIService, 'generateChatCompletion')
        .mockRejectedValue(new Error('LLM intentionally disabled for deterministic routing test'));
      const infrastructure = await router.classifyDemandForRouting(
        'Migrar deploy',
        'Planejar infraestrutura cloud e rollback.',
        'infraestrutura',
        AVAILABLE_AGENTS,
      );
      const legaltech = await router.classifyDemandForRouting(
        'Privacidade',
        'Revisar requisito regulatório.',
        'security',
        AVAILABLE_AGENTS,
        'legaltech_lgpd',
      );

      expect(infrastructure.selectedAgents).toContain('architect');
      expect(infrastructure.method).toBe('registry');
      expect(legaltech.selectedAgents).toContain('security_specialist');
      expect(legaltech.method).toBe('registry');
      llmSpy.mockRestore();
    });
  });
});
