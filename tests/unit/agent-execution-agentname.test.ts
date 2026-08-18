/**
 * Spec 028 (T6 / US4) — `executeAgent` deve propagar `agentName` para
 * `generateChatCompletion`. Sem ele, `applyAgentModelPolicy` cai no
 * DEFAULT_ALLOCATION (agente resolve o modelo errado) e `llm_audit_logs.agent_name`
 * fica vazio. Regressão silenciosa se o campo sumir de novo.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AgentInteractionService } from '../../server/services/agent-interaction';
import { openAIService } from '../../server/services/openai-ai';

const service = new AgentInteractionService();

const demand = {
  id: 987654,
  title: 'Demanda de teste',
  description: 'Analise isto',
  type: 'nova_funcionalidade',
  priority: 'media',
} as never;

describe('Spec 028 T6 — executeAgent propaga agentName', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('passa agentName nas options de generateChatCompletion', async () => {
    const spy = vi
      .spyOn(openAIService, 'generateChatCompletion')
      .mockResolvedValue('resposta do agente');

    await service.executeAgent('tech_lead', demand);

    expect(spy).toHaveBeenCalledTimes(1);
    const options = spy.mock.calls[0][2];
    expect(options).toBeDefined();
    expect(options?.agentName).toBe('tech_lead');
    // A operation continua marcada com o agente (telemetria).
    expect(options?.operation).toBe('agent_execution:tech_lead');
  });
});
