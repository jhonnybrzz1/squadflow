/**
 * Demanda 10081 parte B — escalonamento dinâmico de agentes no meio do
 * refinamento. O moderador (chamada LLM que já acontece a cada turno) pode
 * sugerir trazer um especialista que não estava na squad inicial;
 * `tryEscalateAgent` decide se aplica.
 *
 * Segue o padrão de teste já usado no arquivo para métodos privados
 * (`decideNextSpeaker`/`consolidate` em roundtable-cache-policy.test.ts e
 * red-team.test.ts): acesso via bracket notation, sem tentar rodar
 * `runRoundTable` inteiro.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../server/services/sse/manager', () => ({
  sseManager: { sendRoundtableEvent: vi.fn() },
}));

vi.mock('../../server/services/openai-ai', () => ({
  openAIService: { generateChatCompletionWithMetadata: vi.fn() },
}));

import { openAIService } from '../../server/services/openai-ai';
import { sseManager } from '../../server/services/sse/manager';
import {
  RoundtableOrchestrator,
  buildModeratorSystemPrompt,
} from '../../server/services/ai-squad/roundtable-orchestrator';
import { featureFlags } from '../../server/services/feature-flags';
import type { Demand } from '@shared/schema';

function buildDemand(overrides?: Partial<Demand>): Demand {
  return {
    id: 111,
    title: 'Ajustar preço do plano',
    description: 'desc',
    type: 'melhoria',
    priority: 'alta',
    status: 'processing',
    progress: 0,
    refinementType: 'business',
    createdAt: new Date(),
    ...overrides,
  } as Demand;
}

describe('buildModeratorSystemPrompt — seção de escalonamento', () => {
  it('não menciona escalonamento quando availableExtraAgents é undefined', () => {
    const prompt = buildModeratorSystemPrompt(['product_owner', 'tech_lead'], []);
    expect(prompt).not.toContain('escalate_agent');
    expect(prompt).not.toContain('ESPECIALISTAS DISPONÍVEIS');
  });

  it('não menciona escalonamento quando availableExtraAgents está vazio', () => {
    const prompt = buildModeratorSystemPrompt(['product_owner', 'tech_lead'], [], {});
    expect(prompt).not.toContain('escalate_agent');
  });

  it('inclui a seção e o campo JSON quando há agentes extras', () => {
    const prompt = buildModeratorSystemPrompt(['product_owner', 'tech_lead'], [], {
      financial_analyst: 'Análise financeira',
    });
    expect(prompt).toContain('ESPECIALISTAS DISPONÍVEIS MAS NÃO NA SQUAD ATUAL');
    expect(prompt).toContain('financial_analyst: Análise financeira');
    expect(prompt).toContain('escalate_agent');
    expect(prompt).toContain('escalate_reason');
  });
});

describe('decideNextSpeaker — repassa escalate_agent/escalate_reason da LLM', () => {
  let orchestrator: RoundtableOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    orchestrator = new RoundtableOrchestrator({
      agentConfigs: {
        product_owner: { system_prompt: 'x', description: 'PO' },
        tech_lead: { system_prompt: 'x', description: 'TL' },
        financial_analyst: { system_prompt: 'x', description: 'Análise financeira' },
      },
    } as any);
  });

  it('flag OFF: não monta seção de escalonamento no prompt do moderador', async () => {
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
      roundtableModeratorMode: 'llm',
      selfConsistencyEnabled: false,
      moderatorMaxHistoryTurns: 3,
      enableDynamicAgentEscalation: false,
    } as any);
    vi.mocked(openAIService.generateChatCompletionWithMetadata).mockResolvedValueOnce({
      content: JSON.stringify({
        next_speaker: 'tech_lead',
        reason: 'r',
        dialogue_move: 'support',
        should_continue: true,
      }),
      metadata: {} as any,
    });

    const demand = buildDemand();
    await orchestrator['decideNextSpeaker'](
      demand.id,
      demand,
      ['product_owner', 'tech_lead'],
      ['[product_owner] product_owner: Olá'],
      1,
      5,
      0,
      3,
    );

    const systemPromptSent = vi.mocked(openAIService.generateChatCompletionWithMetadata).mock
      .calls[0][0] as string;
    expect(systemPromptSent).not.toContain('escalate_agent');
  });

  it('regressão real (demanda 10084, 2026-07-23): JSON null em escalate_agent/escalate_reason não quebra o parse', async () => {
    // Modelos frequentemente devolvem `null` (não omitem a chave) para "sem
    // valor" em JSON — .optional() sozinho (sem .nullish()) rejeitava isso e
    // derrubava a decisão INTEIRA do moderador pra fallback round-robin.
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
      roundtableModeratorMode: 'llm',
      selfConsistencyEnabled: false,
      moderatorMaxHistoryTurns: 3,
      enableDynamicAgentEscalation: true,
    } as any);
    vi.mocked(openAIService.generateChatCompletionWithMetadata).mockResolvedValueOnce({
      content: JSON.stringify({
        next_speaker: 'tech_lead',
        reason: 'r',
        dialogue_move: 'support',
        should_continue: true,
        escalate_agent: null,
        escalate_reason: null,
      }),
      metadata: {} as any,
    });

    const demand = buildDemand();
    const decision = await orchestrator['decideNextSpeaker'](
      demand.id,
      demand,
      ['product_owner', 'tech_lead'],
      ['[product_owner] product_owner: Olá'],
      1,
      5,
      0,
      3,
    );

    // Se o parse tivesse falhado, cairia no fallback round-robin com reason
    // "Próximo na ordem de discussão" — o teste prova que a decisão real da
    // LLM (next_speaker: tech_lead, reason: "r") foi aceita.
    expect(decision.next_speaker).toBe('tech_lead');
    expect(decision.reason).toBe('r');
    expect(decision.escalate_agent).toBeNull();
  });

  it('flag ON: repassa escalate_agent/escalate_reason quando a LLM sugere', async () => {
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
      roundtableModeratorMode: 'llm',
      selfConsistencyEnabled: false,
      moderatorMaxHistoryTurns: 3,
      enableDynamicAgentEscalation: true,
    } as any);
    vi.mocked(openAIService.generateChatCompletionWithMetadata).mockResolvedValueOnce({
      content: JSON.stringify({
        next_speaker: 'tech_lead',
        reason: 'r',
        dialogue_move: 'support',
        should_continue: true,
        escalate_agent: 'financial_analyst',
        escalate_reason: 'Demanda de precificação precisa de análise financeira',
      }),
      metadata: {} as any,
    });

    const demand = buildDemand();
    const decision = await orchestrator['decideNextSpeaker'](
      demand.id,
      demand,
      ['product_owner', 'tech_lead'],
      ['[product_owner] product_owner: Olá'],
      1,
      5,
      0,
      3,
    );

    const systemPromptSent = vi.mocked(openAIService.generateChatCompletionWithMetadata).mock
      .calls[0][0] as string;
    expect(systemPromptSent).toContain('financial_analyst: Análise financeira');
    expect(decision.escalate_agent).toBe('financial_analyst');
    expect(decision.escalate_reason).toBe('Demanda de precificação precisa de análise financeira');
  });
});

describe('tryEscalateAgent', () => {
  let orchestrator: RoundtableOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    orchestrator = new RoundtableOrchestrator({
      agentConfigs: {
        product_owner: { system_prompt: 'x', description: 'PO' },
        tech_lead: { system_prompt: 'x', description: 'TL' },
        financial_analyst: { system_prompt: 'x', description: 'Análise financeira' },
      },
    } as any);
  });

  function baseParams(overrides?: Partial<Record<string, unknown>>) {
    return {
      demandId: 1,
      decision: {
        next_speaker: 'tech_lead',
        reason: 'r',
        dialogue_move: 'support' as const,
        should_continue: true,
        escalate_agent: 'financial_analyst',
        escalate_reason: 'motivo',
      },
      effectiveAgents: ['product_owner', 'tech_lead'],
      escalations: [] as Array<{ agent: string; round: number; reason: string }>,
      maxDynamicEscalations: 2,
      maxRounds: 3,
      refinementLevel: 3 as const,
      currentRound: 1,
      ...overrides,
    };
  }

  it('flag OFF: não aplica escalonamento', () => {
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
      enableDynamicAgentEscalation: false,
    } as any);
    const params = baseParams();
    const result = orchestrator['tryEscalateAgent'](params);
    expect(result).toBeNull();
    expect(params.effectiveAgents).toEqual(['product_owner', 'tech_lead']);
    expect(params.escalations).toEqual([]);
  });

  it('flag ON: empurra o agente, recalcula maxTurns/tokenBudget e registra a escalação', () => {
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
      enableDynamicAgentEscalation: true,
    } as any);
    const params = baseParams();
    const result = orchestrator['tryEscalateAgent'](params);

    expect(result).not.toBeNull();
    expect(params.effectiveAgents).toEqual(['product_owner', 'tech_lead', 'financial_analyst']);
    expect(params.escalations).toEqual([
      { agent: 'financial_analyst', round: 1, reason: 'motivo' },
    ]);
    expect(sseManager.sendRoundtableEvent).toHaveBeenCalledWith(
      1,
      'roundtable_agent_joined',
      expect.objectContaining({ agent: 'financial_analyst', round: 1, reason: 'motivo' }),
    );
    // maxTurns recalculado pro novo tamanho (3 agentes), não o antigo (2).
    expect(result!.maxTurns).toBeGreaterThan(0);
  });

  it('não escala quando não há escalate_agent na decisão', () => {
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
      enableDynamicAgentEscalation: true,
    } as any);
    const params = baseParams({
      decision: {
        next_speaker: 'tech_lead',
        reason: 'r',
        dialogue_move: 'support' as const,
        should_continue: true,
      },
    });
    expect(orchestrator['tryEscalateAgent'](params)).toBeNull();
  });

  it('não escala quando escalate_agent vem como JSON null (não só undefined)', () => {
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
      enableDynamicAgentEscalation: true,
    } as any);
    const params = baseParams({
      decision: {
        next_speaker: 'tech_lead',
        reason: 'r',
        dialogue_move: 'support' as const,
        should_continue: true,
        escalate_agent: null,
        escalate_reason: null,
      },
    });
    expect(orchestrator['tryEscalateAgent'](params)).toBeNull();
    expect(params.effectiveAgents).toEqual(['product_owner', 'tech_lead']);
  });

  it('não escala um agente já presente em effectiveAgents', () => {
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
      enableDynamicAgentEscalation: true,
    } as any);
    const params = baseParams({ effectiveAgents: ['product_owner', 'financial_analyst'] });
    expect(orchestrator['tryEscalateAgent'](params)).toBeNull();
  });

  it('não escala um agente sem config ativa (nome alucinado/inexistente)', () => {
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
      enableDynamicAgentEscalation: true,
    } as any);
    const params = baseParams({
      decision: {
        next_speaker: 'tech_lead',
        reason: 'r',
        dialogue_move: 'support' as const,
        should_continue: true,
        escalate_agent: 'agente_que_nao_existe',
        escalate_reason: 'motivo',
      },
    });
    expect(orchestrator['tryEscalateAgent'](params)).toBeNull();
  });

  it('respeita o teto de escalonamentos por run', () => {
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
      enableDynamicAgentEscalation: true,
    } as any);
    const params = baseParams({
      escalations: [
        { agent: 'a', round: 1, reason: 'x' },
        { agent: 'b', round: 1, reason: 'y' },
      ],
      maxDynamicEscalations: 2,
    });
    expect(orchestrator['tryEscalateAgent'](params)).toBeNull();
  });

  it('usa motivo default quando escalate_reason vem vazio', () => {
    vi.spyOn(featureFlags, 'getFlags').mockReturnValue({
      enableDynamicAgentEscalation: true,
    } as any);
    const params = baseParams({
      decision: {
        next_speaker: 'tech_lead',
        reason: 'r',
        dialogue_move: 'support' as const,
        should_continue: true,
        escalate_agent: 'financial_analyst',
        escalate_reason: '',
      },
    });
    orchestrator['tryEscalateAgent'](params);
    expect(params.escalations[0].reason).toBe('Necessidade identificada pelo moderador');
  });
});
