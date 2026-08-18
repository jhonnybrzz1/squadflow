/**
 * Spec "Ajustes claude" F2 — parecer síncrono do TechLead.
 * Cobre: sucesso, execução inexistente (404 via NotFoundError) e falha do LLM
 * propagada. O recurso avaliado é sempre um job específico do Claude.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const jobsMock = vi.hoisted(() => ({ findById: vi.fn() }));
const openaiMock = vi.hoisted(() => ({ generateChatCompletionWithMetadata: vi.fn() }));

vi.mock('../../server/services/agent-jobs', () => ({ agentJobsService: jobsMock }));
vi.mock('../../server/services/openai-ai', () => ({ openAIService: openaiMock }));
vi.mock('../../server/services/ai-squad/AgentFactory', () => ({
  AgentFactory: class {
    loadConfigurations() {
      return {
        agents: [],
        agentConfigs: {
          tech_lead: {
            system_prompt: 'Você é o Tech Lead.',
            model: 'test-model',
            temperature: 0.3,
            max_tokens: 1000,
          },
        },
      };
    }
  },
}));

import { requestTechLeadReview } from '../../server/services/tech-lead-review';
import { NotFoundError } from '../../server/middleware/error-handler';

const job = {
  id: 'job-7',
  demandId: 7,
  status: 'succeeded',
  filesModified: ['a.ts'],
  typecheckPassed: true,
  errorMessage: null,
  steps: [{ kind: 'text', label: 'implementei' }],
};

beforeEach(() => {
  jobsMock.findById.mockReset();
  openaiMock.generateChatCompletionWithMetadata.mockReset();
});

describe('requestTechLeadReview (F2)', () => {
  it('retorna o parecer no sucesso', async () => {
    jobsMock.findById.mockResolvedValue(job);
    openaiMock.generateChatCompletionWithMetadata.mockResolvedValue({
      content: '## Resumo\nBom trabalho.',
      metadata: { modelUsed: 'resolved-model' },
    });

    const review = await requestTechLeadReview('job-7');
    expect(review.parecer).toContain('Resumo');
    expect(review.jobId).toBe('job-7');
    expect(review.model).toBe('resolved-model');
    // O system prompt do tech_lead foi usado.
    const [systemPrompt, , options] = openaiMock.generateChatCompletionWithMetadata.mock.calls[0];
    expect(systemPrompt).toContain('Tech Lead');
    // Demanda 10086: parecer é conteúdo interno — um soluço transitório do
    // guardrail não pode derrubar tudo com 502. failOpenOnError deve estar ligado.
    expect(options).toMatchObject({ failOpenOnError: true, operation: 'tech_lead_review' });
  });

  it('lança NotFoundError quando a execução não existe', async () => {
    jobsMock.findById.mockResolvedValue(null);
    await expect(requestTechLeadReview('job-inexistente')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('propaga falha do LLM', async () => {
    jobsMock.findById.mockResolvedValue(job);
    openaiMock.generateChatCompletionWithMetadata.mockRejectedValue(new Error('LLM down'));
    await expect(requestTechLeadReview('job-7')).rejects.toThrow('LLM down');
  });

  it('trata parecer vazio como erro', async () => {
    jobsMock.findById.mockResolvedValue(job);
    openaiMock.generateChatCompletionWithMetadata.mockResolvedValue({
      content: '   ',
      metadata: { modelUsed: 'm' },
    });
    await expect(requestTechLeadReview('job-7')).rejects.toThrow(/vazio/);
  });
});
