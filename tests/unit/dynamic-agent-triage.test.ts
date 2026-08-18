/**
 * Demanda 10081 parte A — triagem semântica de agentes.
 *
 * Cobre: seleção válida, product_owner sempre forçado, nomes alucinados
 * filtrados, e o contrato de fallback absoluto (erro, JSON inválido,
 * confiança baixa, exceção) — o caller sempre pode confiar em `fallback:true`
 * para cair na squad estática sem checar mais nada.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { generateJSONResponse } = vi.hoisted(() => ({ generateJSONResponse: vi.fn() }));
vi.mock('../../server/services/openai-ai', () => ({
  openAIService: { generateJSONResponse },
}));

const { loadConfigurations } = vi.hoisted(() => ({ loadConfigurations: vi.fn() }));
vi.mock('../../server/services/ai-squad/AgentFactory', () => ({
  AgentFactory: class {
    loadConfigurations() {
      return loadConfigurations();
    }
  },
}));

vi.mock('../../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { selectAgentsForDemand } from '../../server/services/dynamic-agent-triage';
import { MIN_ROUNDTABLE_AGENTS } from '@shared/agent-roles';

const CATALOG = {
  agentConfigs: {
    product_owner: { description: 'Garante escopo e ROI', system_prompt: 'x' },
    tech_lead: { description: 'Avalia viabilidade técnica', system_prompt: 'x' },
    qa: { description: 'Define critérios de teste', system_prompt: 'x' },
    financial_analyst: { description: 'Análise financeira', system_prompt: 'x' },
  },
};

const DEMAND = { title: 'Ajustar preço do plano', description: 'desc', type: 'melhoria' };

describe('selectAgentsForDemand', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('retorna a seleção do LLM, com product_owner forçado mesmo se o LLM não incluir', async () => {
    loadConfigurations.mockReturnValue(CATALOG);
    generateJSONResponse.mockResolvedValue({
      selectedAgents: ['financial_analyst', 'tech_lead'],
      reasoning: 'Demanda de precificação',
      confidence: 0.9,
    });

    const result = await selectAgentsForDemand(DEMAND);

    expect(result.fallback).toBe(false);
    expect(result.selectedAgents).toEqual(['product_owner', 'financial_analyst', 'tech_lead']);
    expect(result.confidence).toBe(0.9);
  });

  it('não duplica product_owner quando o LLM já o incluiu', async () => {
    loadConfigurations.mockReturnValue(CATALOG);
    generateJSONResponse.mockResolvedValue({
      selectedAgents: ['product_owner', 'qa'],
      reasoning: 'r',
      confidence: 0.8,
    });

    const result = await selectAgentsForDemand(DEMAND);
    // ALTO-01: preserva a escolha do LLM e completa até o quórum na ordem
    // canônica — do catálogo, só tech_lead ainda cabe.
    expect(result.selectedAgents).toEqual(['product_owner', 'qa', 'tech_lead']);
  });

  it('filtra nomes de agentes alucinados (fora do catálogo)', async () => {
    loadConfigurations.mockReturnValue(CATALOG);
    generateJSONResponse.mockResolvedValue({
      selectedAgents: ['tech_lead', 'agente_que_nao_existe'],
      reasoning: 'r',
      confidence: 0.8,
    });

    const result = await selectAgentsForDemand(DEMAND);
    expect(result.selectedAgents).toEqual(['product_owner', 'tech_lead', 'qa']);
  });

  it('fallback quando a confiança está abaixo do piso (0.5)', async () => {
    loadConfigurations.mockReturnValue(CATALOG);
    generateJSONResponse.mockResolvedValue({
      selectedAgents: ['tech_lead'],
      reasoning: 'r',
      confidence: 0.3,
    });

    const result = await selectAgentsForDemand(DEMAND);
    expect(result.fallback).toBe(true);
    expect(result.selectedAgents).toEqual([]);
  });

  it('fallback quando generateJSONResponse lança (JSON inválido, timeout, etc.)', async () => {
    loadConfigurations.mockReturnValue(CATALOG);
    generateJSONResponse.mockRejectedValue(new Error('invalid JSON'));

    const result = await selectAgentsForDemand(DEMAND);
    expect(result.fallback).toBe(true);
  });

  it('fallback quando o catálogo de agentes está vazio', async () => {
    loadConfigurations.mockReturnValue({ agentConfigs: {} });

    const result = await selectAgentsForDemand(DEMAND);
    expect(result.fallback).toBe(true);
    expect(generateJSONResponse).not.toHaveBeenCalled();
  });

  it('fallback quando a seleção filtrada fica vazia (só nomes alucinados)', async () => {
    loadConfigurations.mockReturnValue(CATALOG);
    generateJSONResponse.mockResolvedValue({
      selectedAgents: ['inexistente_a', 'inexistente_b'],
      reasoning: 'r',
      confidence: 0.9,
    });

    const result = await selectAgentsForDemand(DEMAND);
    // product_owner é forçado, então nunca fica vazio de fato. ALTO-01: sozinho
    // ele não dá quórum, então a squad é completada na ordem canônica.
    expect(result.fallback).toBe(false);
    expect(result.selectedAgents).toEqual(['product_owner', 'tech_lead', 'qa']);
  });

  // ALTO-01: a triagem é dona do quórum. Antes ela garantia só `length > 0` e a
  // demanda morria com 400 em DemandService.enrich — no caminho vivo de
  // POST /api/demands, com a flag ligada em produção.
  it('completa a squad até o quórum quando o LLM devolve um único especialista', async () => {
    loadConfigurations.mockReturnValue(CATALOG);
    generateJSONResponse.mockResolvedValue({
      selectedAgents: ['financial_analyst'],
      reasoning: 'squad enxuta',
      confidence: 0.9,
    });

    const result = await selectAgentsForDemand(DEMAND);

    expect(result.fallback).toBe(false);
    expect(result.selectedAgents).toHaveLength(MIN_ROUNDTABLE_AGENTS);
    // A escolha do LLM é preservada; o complemento vem da squad canônica.
    expect(result.selectedAgents).toEqual(['product_owner', 'financial_analyst', 'tech_lead']);
  });

  it('não mexe na squad quando o LLM já devolve quórum', async () => {
    loadConfigurations.mockReturnValue(CATALOG);
    generateJSONResponse.mockResolvedValue({
      selectedAgents: ['product_owner', 'tech_lead', 'qa', 'financial_analyst'],
      reasoning: 'r',
      confidence: 0.9,
    });

    const result = await selectAgentsForDemand(DEMAND);

    expect(result.selectedAgents).toEqual([
      'product_owner',
      'tech_lead',
      'qa',
      'financial_analyst',
    ]);
  });

  it('cai em fallback quando o catálogo não tem agentes suficientes para o quórum', async () => {
    loadConfigurations.mockReturnValue({
      agentConfigs: { product_owner: { description: 'PO', system_prompt: 'x' } },
    });
    generateJSONResponse.mockResolvedValue({
      selectedAgents: ['product_owner'],
      reasoning: 'r',
      confidence: 0.9,
    });

    const result = await selectAgentsForDemand(DEMAND);

    expect(result.fallback).toBe(true);
    expect(result.selectedAgents).toEqual([]);
  });

  it('passa failOpenOnError: true para a chamada LLM (conteúdo não é input adversarial)', async () => {
    loadConfigurations.mockReturnValue(CATALOG);
    generateJSONResponse.mockResolvedValue({
      selectedAgents: ['tech_lead'],
      reasoning: 'r',
      confidence: 0.9,
    });

    await selectAgentsForDemand(DEMAND);

    expect(generateJSONResponse.mock.calls[0][2]).toMatchObject({ failOpenOnError: true });
  });
});
