import { describe, it, expect } from 'vitest';
import {
  OpenAIService,
  openAIService,
  GuardrailBlockError,
  generateEmbedding,
  generateEmbeddings,
  isUsingLocalEmbeddings,
  resolveGuardrailProfile,
  getDefaultGuardrailProfile,
  type AIChatMessage,
  type CompletionOptions,
} from '../../server/services/openai-ai';

describe('openai-ai public contract (10209)', () => {
  it('exports OpenAIService singleton and class', () => {
    expect(OpenAIService).toBeDefined();
    expect(openAIService).toBeInstanceOf(OpenAIService);
  });

  it('exports GuardrailBlockError', () => {
    const err = new GuardrailBlockError('msg', 'reason');
    expect(err.isGuardrailBlock).toBe(true);
    expect(err.reason).toBe('reason');
  });

  it('preserves AIChatMessage type shape at runtime', () => {
    const msg: AIChatMessage = { role: 'user', content: 'hello' };
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('hello');
  });

  it('exports embedding helpers', () => {
    expect(typeof generateEmbedding).toBe('function');
    expect(typeof generateEmbeddings).toBe('function');
    expect(typeof isUsingLocalEmbeddings).toBe('function');
  });

  it('resolveGuardrailProfile returns relaxed by default', () => {
    expect(resolveGuardrailProfile({ stream: false } as CompletionOptions)).toBe('relaxed');
  });

  it('resolveGuardrailProfile returns strict when requested for non-streaming', () => {
    expect(
      resolveGuardrailProfile({ stream: false, guardrailProfile: 'strict' } as CompletionOptions),
    ).toBe('strict');
  });

  it('resolveGuardrailProfile rejects stream+strict', () => {
    expect(() =>
      resolveGuardrailProfile({ stream: true, guardrailProfile: 'strict' } as CompletionOptions),
    ).toThrow('stream: true cannot be combined with guardrailProfile: strict');
  });

  it('DEFAULT_GUARDRAIL_PROFILE env var is respected', () => {
    const original = process.env.DEFAULT_GUARDRAIL_PROFILE;
    process.env.DEFAULT_GUARDRAIL_PROFILE = 'strict';
    expect(getDefaultGuardrailProfile()).toBe('strict');
    process.env.DEFAULT_GUARDRAIL_PROFILE = 'invalid';
    expect(getDefaultGuardrailProfile()).toBe('relaxed');
    process.env.DEFAULT_GUARDRAIL_PROFILE = original;
  });
});
