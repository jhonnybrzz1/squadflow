import { describe, it, expect } from 'vitest';
import {
  OpenAIService,
  openAIService,
  getLLMClient,
  hasLLMClient,
  applyGuardrails,
  GuardrailBlockError,
  generateEmbedding,
  generateEmbeddings,
  isUsingLocalEmbeddings,
  resolveGuardrailProfile,
  getDefaultGuardrailProfile,
  DEFAULT_BATCH_CONCURRENCY,
  MAX_BATCH_CONCURRENCY,
  DEFAULT_CHAT_TIMEOUT_MS,
  isQualityFailure,
} from '../../server/services/openai-ai';

describe('P3: openai-ai module smoke tests', () => {
  it('client module exports getLLMClient / hasLLMClient', () => {
    expect(typeof getLLMClient).toBe('function');
    expect(typeof hasLLMClient).toBe('function');
  });

  it('guardrails module exports applyGuardrails and GuardrailBlockError', () => {
    expect(typeof applyGuardrails).toBe('function');
    const err = new GuardrailBlockError('blocked', 'reason');
    expect(err.isGuardrailBlock).toBe(true);
  });

  it('embeddings module exports embedding helpers', () => {
    expect(typeof generateEmbedding).toBe('function');
    expect(typeof generateEmbeddings).toBe('function');
    expect(typeof isUsingLocalEmbeddings).toBe('function');
  });

  it('completions module exports profile helpers', () => {
    expect(typeof resolveGuardrailProfile).toBe('function');
    expect(typeof getDefaultGuardrailProfile).toBe('function');
    expect(resolveGuardrailProfile({ stream: false })).toBe('relaxed');
  });

  it('retry module exports retry constants and isQualityFailure', () => {
    expect(DEFAULT_BATCH_CONCURRENCY).toBe(4);
    expect(MAX_BATCH_CONCURRENCY).toBe(10);
    expect(DEFAULT_CHAT_TIMEOUT_MS).toBe(120_000);
    expect(isQualityFailure(new Error('fail'), 'ok')).toBe(true);
    expect(isQualityFailure(null, '')).toBe(true);
    expect(isQualityFailure(null, 'ok')).toBe(false);
  });

  it('OpenAIService facade is still a singleton', () => {
    expect(openAIService).toBeInstanceOf(OpenAIService);
  });

  it('modifying guardrail threshold does not affect retry helper', () => {
    // Teste funcional de desacoplamento: guardrails e retry são módulos
    // independentes; alterar o perfil padrão não afeta isQualityFailure.
    process.env.DEFAULT_GUARDRAIL_PROFILE = 'strict';
    expect(getDefaultGuardrailProfile()).toBe('strict');
    expect(isQualityFailure(null, 'ok')).toBe(false);
    process.env.DEFAULT_GUARDRAIL_PROFILE = 'relaxed';
    expect(getDefaultGuardrailProfile()).toBe('relaxed');
  });
});
