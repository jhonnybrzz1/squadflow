/**
 * Groundedness and Sentence Extraction Tests
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock openAIService
vi.mock('../server/services/openai-ai', () => ({
  openAIService: {
    generateChatCompletion: vi.fn(),
  },
}));

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { GroundednessValidator } from '../server/services/groundedness-validator';
import { openAIService } from '../server/services/openai-ai';

// Textos com overlap intermediário (entre 0.2 e 0.5) para forçar o caminho do LLM-judge.
const LLM_CONTEXT =
  'O sistema de checkout processa pagamentos com cartão de crédito e confirma a transação de forma segura. Ele também valida o número do cartão e verifica o saldo antes da autorização.';
const LLM_DOCUMENT =
  'O sistema de checkout processa pagamentos com cartão de crédito e confirma a transação de forma segura. O usuário pode escolher parcelamento em até doze vezes.';

describe('GroundednessValidator — LLM-as-judge de fidelidade factual', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deve retornar isGrounded: true e score alto se o LLM-judge validar o documento', async () => {
    const mockJson = JSON.stringify({
      score: 0.95,
      isGrounded: true,
      issues: [],
    });

    vi.mocked(openAIService.generateChatCompletion).mockResolvedValueOnce(mockJson);

    const result = await GroundednessValidator.validate(LLM_DOCUMENT, LLM_CONTEXT, 101);

    expect(result.isGrounded).toBe(true);
    expect(result.score).toBe(0.95);
    expect(result.issues).toEqual([]);
    expect(result.answerSource).toBe('validated');
    expect(typeof result.overlapScore).toBe('number');
    expect(openAIService.generateChatCompletion).toHaveBeenCalledOnce();
  });

  it('deve retornar isGrounded: false e listar falhas se o LLM-judge identificar alucinações', async () => {
    const mockJson = JSON.stringify({
      score: 0.4,
      isGrounded: false,
      issues: [
        'O documento cita o arquivo auth-service.ts que não existe',
        'Checkout alucinou tempo de resposta de 1s',
      ],
    });

    vi.mocked(openAIService.generateChatCompletion).mockResolvedValueOnce(mockJson);

    const result = await GroundednessValidator.validate(LLM_DOCUMENT, LLM_CONTEXT, 102);

    expect(result.isGrounded).toBe(false);
    expect(result.score).toBe(0.4);
    expect(result.issues.length).toBe(2);
    expect(result.issues[0]).toContain('auth-service.ts');
    expect(result.answerSource).toBe('validated');
  });

  it('A-2: fail-open quando o LLM-judge falha (network error)', async () => {
    vi.mocked(openAIService.generateChatCompletion).mockRejectedValueOnce(
      new Error('Network error'),
    );

    const result = await GroundednessValidator.validate(LLM_DOCUMENT, LLM_CONTEXT, 103);

    expect(result.isGrounded).toBe(false);
    expect(result.score).toBeNull();
    expect(result.degradeMode).toBe(true);
    expect(result.fallback).toBe(true);
    expect(result.issues).toEqual(['llm_failure']);
    expect(result.answerSource).toBe('unvalidated');
  });

  it('A-2: fail-open quando o LLM-judge responde JSON malformado', async () => {
    vi.mocked(openAIService.generateChatCompletion).mockResolvedValueOnce('{not valid json');

    const result = await GroundednessValidator.validate(LLM_DOCUMENT, LLM_CONTEXT, 104);

    expect(result.isGrounded).toBe(false);
    expect(result.score).toBeNull();
    expect(result.degradeMode).toBe(true);
    expect(result.issues).toEqual(['llm_failure']);
    expect(result.answerSource).toBe('unvalidated');
  });

  it('A-2: rejeita source vazio sem chamar o juiz LLM', async () => {
    const result = await GroundednessValidator.validate('Documento qualquer', '   ', 105);

    expect(result.isGrounded).toBe(false);
    expect(result.score).toBe(0);
    expect(result.skippedNoContext).toBe(true);
    expect(result.issues).toEqual(['empty_content_or_context']);
    expect(result.answerSource).toBe('unvalidated');
    expect(result.overlapScore).toBe(0);
    expect(openAIService.generateChatCompletion).not.toHaveBeenCalled();
  });

  it('A-2: rejeita documento vazio sem chamar o juiz LLM', async () => {
    const result = await GroundednessValidator.validate('   ', 'Contexto RAG', 106);

    expect(result.isGrounded).toBe(false);
    expect(result.skippedNoContext).toBe(true);
    expect(result.issues).toEqual(['empty_content_or_context']);
    expect(result.answerSource).toBe('unvalidated');
    expect(openAIService.generateChatCompletion).not.toHaveBeenCalled();
  });

  it('A-2: bigram pré-filtro rejeita semelhança muito baixa sem chamar LLM', async () => {
    const result = await GroundednessValidator.validate(
      'futebol sol lua viagem espacial',
      'receita de bolo de cenoura chocolate cobertura',
      107,
    );

    expect(result.isGrounded).toBe(false);
    expect(result.issues).toEqual(['bigram_overlap_below_threshold']);
    expect(result.overlapScore).toBeLessThan(0.2);
    expect(result.answerSource).toBe('unvalidated');
    expect(openAIService.generateChatCompletion).not.toHaveBeenCalled();
  });

  it('A-2: bigram pré-filtro aprova semelhança muito alta sem chamar LLM', async () => {
    const result = await GroundednessValidator.validate(
      'o gato comeu o rato no quintal',
      'o gato comeu o rato no quintal de casa',
      108,
    );

    expect(result.isGrounded).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.issues).toEqual([]);
    expect(typeof result.overlapScore).toBe('number');
    expect(result.overlapScore).toBeGreaterThanOrEqual(0.5);
    expect(result.answerSource).toBe('validated');
    expect(openAIService.generateChatCompletion).not.toHaveBeenCalled();
  });

  it('não marca skippedNoContext quando documento e contexto estão presentes', async () => {
    const mockJson = JSON.stringify({ score: 0.9, isGrounded: true, issues: [] });

    vi.mocked(openAIService.generateChatCompletion).mockResolvedValueOnce(mockJson);

    const result = await GroundednessValidator.validate(LLM_DOCUMENT, LLM_CONTEXT, 109);

    expect(result.skippedNoContext).toBeUndefined();
    expect(result.answerSource).toBe('validated');
  });
});
