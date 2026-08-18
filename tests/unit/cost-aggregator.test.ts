/**
 * Spec 008 / US4: custo por agente/ferramenta rastreável — o parser precisa
 * reconhecer TODAS as variantes de rótulo usadas pelos fluxos reais e declarar
 * o não-atribuível em `unattributed` (nunca sumir em silêncio).
 * Contrato: specs/008-correcoes-pos-qa-005-006-007/contracts/cost-breakdown-contract.md
 */
import { describe, expect, it } from 'vitest';

import {
  aggregateDemandCosts,
  parseAgentFromOperation,
  parseToolFromOperation,
} from '../../server/services/demand-cost-aggregator';
import type { AIUsageRecord } from '../../server/services/ai-usage-tracker';

function makeRecord(operation: string, cost: number, tokens: number, model = 'x:m'): AIUsageRecord {
  return {
    timestamp: '2026-07-16T00:00:00Z',
    demandId: 1,
    operation,
    model,
    promptTokens: Math.floor(tokens / 2),
    completionTokens: Math.ceil(tokens / 2),
    totalTokens: tokens,
    estimatedCostUsd: cost,
    cacheHit: false,
    estimatedTokensSaved: 0,
    estimatedCostSavedUsd: null,
    latencyMs: 100,
  };
}

describe('parseAgentFromOperation', () => {
  it('reconhece todas as variantes de rótulo de agente dos fluxos reais', () => {
    // server/services/agent-interaction.ts
    expect(parseAgentFromOperation('agent_interaction:qa')).toBe('qa');
    expect(parseAgentFromOperation('agent_execution:tech_lead')).toBe('tech_lead');
    // server/services/ai-squad.ts
    expect(parseAgentFromOperation('agent:product_owner:streaming')).toBe('product_owner');
    expect(parseAgentFromOperation('agent:ux:reflection')).toBe('ux');
    // server/services/ai-squad/roundtable-orchestrator.ts
    expect(parseAgentFromOperation('roundtable:product_manager:turn2')).toBe('product_manager');
    expect(parseAgentFromOperation('roundtable:moderator')).toBe('moderator');
  });

  it('retorna null para operações que não são de agente', () => {
    expect(parseAgentFromOperation('document:prd')).toBeNull();
    expect(parseAgentFromOperation('plugin:discovery')).toBeNull();
    expect(parseAgentFromOperation('tool:web_search')).toBeNull();
    expect(parseAgentFromOperation('embedding')).toBeNull();
    expect(parseAgentFromOperation('agent:')).toBeNull();
  });
});

describe('parseToolFromOperation', () => {
  it('reconhece tool:<nome> e ignora o resto', () => {
    expect(parseToolFromOperation('tool:web_search')).toBe('web_search');
    expect(parseToolFromOperation('agent:qa')).toBeNull();
    expect(parseToolFromOperation('tool:')).toBeNull();
  });
});

describe('aggregateDemandCosts (spec 008 / US4)', () => {
  it('popula byAgent para as variantes reais de rótulo (T019)', () => {
    const records = [
      makeRecord('agent_interaction:qa', 0.001, 100),
      makeRecord('agent:product_owner:streaming', 0.002, 200),
      makeRecord('agent_execution:tech_lead', 0.003, 300),
      makeRecord('roundtable:ux:turn1', 0.004, 400),
      makeRecord('tool:web_search', 0.0005, 50),
    ];

    const result = aggregateDemandCosts(records);

    expect(Object.keys(result.byAgent).sort()).toEqual(['product_owner', 'qa', 'tech_lead', 'ux']);
    expect(result.byAgent.qa).toEqual({ cost: 0.001, tokens: 100, count: 1 });
    expect(result.byAgent.product_owner).toEqual({ cost: 0.002, tokens: 200, count: 1 });
    expect(result.byTool.web_search).toEqual({ cost: 0.0005, tokens: 50, count: 1 });
    expect(result.unattributed.count).toBe(0);
  });

  it('agrega fases do mesmo agente sob a mesma chave', () => {
    const records = [
      makeRecord('agent:qa', 0.001, 100),
      makeRecord('agent:qa:reflection', 0.002, 200),
      makeRecord('roundtable:qa:turn3', 0.003, 300),
    ];

    const result = aggregateDemandCosts(records);

    expect(result.byAgent.qa).toEqual({ cost: 0.006, tokens: 600, count: 3 });
  });

  it('acumula operações não reconhecidas em unattributed, sem descartar (T020)', () => {
    const records = [
      makeRecord('document:prd', 0.005, 500),
      makeRecord('plugin:discovery:analysis', 0.002, 200),
      makeRecord('async:structured-consolidation', 0.001, 100),
      makeRecord('agent_interaction:qa', 0.003, 300),
    ];

    const result = aggregateDemandCosts(records);

    expect(result.unattributed).toEqual({ cost: 0.008, tokens: 800, count: 3 });
    expect(result.byAgent.qa.cost).toBeCloseTo(0.003, 10);
  });

  it('soma(byAgent) + soma(byTool) + unattributed ≈ custo total (T024)', () => {
    const records = [
      makeRecord('agent_interaction:qa', 0.0031, 300),
      makeRecord('agent:pm:streaming', 0.0044, 400),
      makeRecord('tool:web_search', 0.0005, 50),
      makeRecord('document:prd', 0.0071, 700),
      makeRecord('embedding', 0.0002, 20),
    ];
    const total = records.reduce((sum, r) => sum + (r.estimatedCostUsd || 0), 0);

    const result = aggregateDemandCosts(records);

    const sumAgents = Object.values(result.byAgent).reduce((s, a) => s + a.cost, 0);
    const sumTools = Object.values(result.byTool).reduce((s, a) => s + a.cost, 0);
    expect(sumAgents + sumTools + result.unattributed.cost).toBeCloseTo(total, 10);

    // byModel é dimensão paralela: também cobre o total
    const sumModels = Object.values(result.byModel).reduce((s, a) => s + a.cost, 0);
    expect(sumModels).toBeCloseTo(total, 10);
  });

  it('demanda sem registros retorna agregados vazios sem erro', () => {
    const result = aggregateDemandCosts([]);
    expect(result.byAgent).toEqual({});
    expect(result.byTool).toEqual({});
    expect(result.byModel).toEqual({});
    expect(result.unattributed).toEqual({ cost: 0, tokens: 0, count: 0 });
  });
});
