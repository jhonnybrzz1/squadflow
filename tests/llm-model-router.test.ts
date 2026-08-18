import { describe, it, expect } from 'vitest';
import {
  resolveModel,
  resolveProvider,
  normalizeModelForProvider,
  isOpenRouterModel,
  prepareProviderMessages,
  resolveMaxTokens,
  FAST_MODEL,
  CAPABLE_MODEL,
} from '../server/services/llm-model-router';

describe('llm-model-router', () => {
  describe('resolveModel', () => {
    it('returns explicit model when provided', () => {
      const result = resolveModel({ model: 'gpt-4' });
      expect(result).toBe('gpt-4');
    });

    it('returns technical model for technical task type', () => {
      const result = resolveModel({ taskType: 'technical' });
      expect(result).toBe(process.env.MISTRAL_MODEL_CODESTRAL || 'codestral-latest');
    });

    it('returns fast model for classification task type', () => {
      const result = resolveModel({ taskType: 'classification' });
      expect(result).toBe(FAST_MODEL);
    });

    it('returns capable model for analysis task type', () => {
      const result = resolveModel({ taskType: 'analysis' });
      expect(result).toBe(CAPABLE_MODEL);
    });

    it('returns fast model for small maxTokens', () => {
      const result = resolveModel({ maxTokens: 200 });
      expect(result).toBe(FAST_MODEL);
    });

    it('returns capable model for large maxTokens', () => {
      const result = resolveModel({ maxTokens: 3000 });
      expect(result).toBe(CAPABLE_MODEL);
    });

    it('returns default model when no criteria match', () => {
      const result = resolveModel({});
      expect(result).toBe(process.env.FAST_MODEL || 'deepseek/deepseek-v4-flash');
    });
  });

  describe('resolveProvider', () => {
    it('returns mistral for mistral models', () => {
      const result = resolveProvider('mistral-medium-3.5');
      expect(result).toBe('mistral');
    });

    it('returns mistral for codestral models', () => {
      const result = resolveProvider('codestral-latest');
      expect(result).toBe('mistral');
    });

    it('returns requested provider when specified', () => {
      const result = resolveProvider('gpt-4', 'openai');
      expect(result).toBe('openai');
    });

    it('returns nvidia for deepseek models', () => {
      const result = resolveProvider('deepseek-ai/deepseek-v4-pro');
      expect(result).toBe('nvidia');
    });

    it('returns openrouter for openrouter models', () => {
      const result = resolveProvider('openrouter/free');
      expect(result).toBe('openrouter');
    });

    it('returns openai by default', () => {
      const result = resolveProvider('gpt-4');
      expect(result).toBe('openai');
    });
  });

  describe('normalizeModelForProvider', () => {
    it('normalizes mistral model names', () => {
      // Legacy mistral-large-3 now normalizes to mistral-medium-3.5 (canonical current model)
      const result = normalizeModelForProvider('mistral-large-3', 'mistral');
      expect(result).toBe('mistral-medium-3.5');
    });

    it('normalizes mistral-medium-latest to mistral-medium-3.5', () => {
      const result = normalizeModelForProvider('mistral-medium-latest', 'mistral');
      expect(result).toBe('mistral-medium-3.5');
    });

    it('returns original model for non-mistral providers', () => {
      const result = normalizeModelForProvider('gpt-4', 'openai');
      expect(result).toBe('gpt-4');
    });
  });

  describe('isOpenRouterModel', () => {
    it('returns true for openrouter/free', () => {
      expect(isOpenRouterModel('openrouter/free')).toBe(true);
    });

    it('returns true for models with slash', () => {
      expect(isOpenRouterModel('deepseek/deepseek-v4-pro')).toBe(true);
    });

    it('returns true for models ending with :free', () => {
      expect(isOpenRouterModel('model:free')).toBe(true);
    });

    it('returns false for regular models', () => {
      expect(isOpenRouterModel('gpt-4')).toBe(false);
    });
  });

  describe('prepareProviderMessages', () => {
    it('returns unchanged messages for openai', () => {
      const messages = [
        { role: 'system', content: 'Hello' },
        { role: 'user', content: 'World' },
      ];
      const result = prepareProviderMessages(messages, 'openai');
      expect(result).toEqual(messages);
    });

    it('maps developer to system for non-openai providers', () => {
      const messages = [{ role: 'developer', content: 'Hello' }];
      const result = prepareProviderMessages(messages, 'mistral');
      expect(result[0].role).toBe('system');
    });
  });

  describe('resolveMaxTokens', () => {
    it('returns explicit maxTokens when provided', () => {
      const result = resolveMaxTokens({ maxTokens: 5000 });
      expect(result).toBe(5000);
    });

    it('returns default for task type', () => {
      const result = resolveMaxTokens({ taskType: 'classification' });
      expect(result).toBe(300);
    });

    it('returns simple default when no criteria match', () => {
      const result = resolveMaxTokens({});
      expect(result).toBe(800);
    });
  });
});
