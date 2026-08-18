import { describe, test, expect } from 'vitest';
import {
  validateModelAllowed,
  validateContract,
  ModelGovernanceError,
  CONTRACT_VERSION,
} from '../server/services/model-governance';

describe('Model Governance', () => {
  describe('validateModelAllowed', () => {
    test('passes for allowed models', () => {
      expect(() => validateModelAllowed('mistral-medium-3.5', 'test_agent', 'test')).not.toThrow();
      expect(() =>
        validateModelAllowed('  MISTRAL-MEDIUM-3.5  ', 'test_agent', 'test'),
      ).not.toThrow();
      expect(() => validateModelAllowed('mistral-small-2603', 'test_agent', 'test')).not.toThrow();
      expect(() =>
        validateModelAllowed('deepseek/deepseek-v4-pro', 'test_agent', 'test'),
      ).not.toThrow();
      expect(() => validateModelAllowed('z-ai/glm-4.7-flash', 'test_agent', 'test')).not.toThrow();
      expect(() => validateModelAllowed('z-ai/glm-5.2', 'test_agent', 'test')).not.toThrow();
      expect(() => validateModelAllowed('glm-5.2', 'test_agent', 'test')).not.toThrow();
      expect(() => validateModelAllowed('mimo-v2.5', 'test_agent', 'test')).not.toThrow();
      expect(() =>
        validateModelAllowed('minimax/minimax-m2.7', 'test_agent', 'test'),
      ).not.toThrow();
      expect(() => validateModelAllowed('minimax-m3', 'test_agent', 'test')).not.toThrow();
      expect(() => validateModelAllowed('qwen/qwen3-coder', 'test_agent', 'test')).not.toThrow();
    });

    test('passes for model registry aliases (governed)', () => {
      // These are stable aliases managed by the Model Registry. They resolve
      // to concrete allowed model ids when the registry is enabled, and are
      // accepted directly when the registry is disabled.
      expect(() => validateModelAllowed('mimo-pro-latest', 'test_agent', 'test')).not.toThrow();
      expect(() =>
        validateModelAllowed('deepseek-v4-pro-latest', 'test_agent', 'test'),
      ).not.toThrow();
      expect(() => validateModelAllowed('glm-latest', 'test_agent', 'test')).not.toThrow();
      expect(() => validateModelAllowed('qwen-coder-latest', 'test_agent', 'test')).not.toThrow();
      expect(() =>
        validateModelAllowed('mistral-medium-latest', 'test_agent', 'test'),
      ).not.toThrow();
    });

    test('throws MODEL_NOT_ALLOWED for unallowed models', () => {
      try {
        // Usando um modelo que NÃO está na allow-list (mistral-large-latest foi removido)
        validateModelAllowed('mistral-large-latest', 'test_agent', 'test');
        expect.unreachable('Should have thrown ModelGovernanceError');
      } catch (error: any) {
        if (error.name === 'AssertionError') throw error;

        const isGovError =
          error.name === 'ModelGovernanceError' || error.code === 'MODEL_NOT_ALLOWED';
        expect(isGovError).toBe(true);

        const govError = error as ModelGovernanceError;
        expect(govError.code).toBe('MODEL_NOT_ALLOWED');
        expect(govError.details).toMatchObject({
          agent: 'test_agent',
          routeContext: 'test',
          modelEfetivo: 'mistral-large-latest',
          contract_version: CONTRACT_VERSION,
          error_code: 'MODEL_NOT_ALLOWED',
        });
      }
    });

    test.each([
      'gpt-4',
      'gpt-4-turbo',
      'gpt-4-turbo-exfiltrator',
      'evil-deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v4-pro-evil',
      'mistral-large-latest',
      'openrouter/auto',
      'z-ai/glm-4.5-air',
    ])('rejects exact-match bypass attempt: %s', (model) => {
      expect(() => validateModelAllowed(model, 'test_agent', 'test')).toThrowError(
        expect.objectContaining({ code: 'MODEL_NOT_ALLOWED' }),
      );
    });

    describe('Model Registry escape hatch (CRIT-01)', () => {
      test('accepts an unlisted concrete id when it was resolved from a governed alias', () => {
        // A promoted candidate id (e.g. a newer version discovered by
        // model-discovery) is never in the static ALLOWED_MODELS list, but it
        // must still be usable once it becomes the alias's activeModelId —
        // otherwise promotion would never have any effect on real inference.
        expect(() =>
          validateModelAllowed(
            'deepseek/deepseek-v5-pro-promoted-candidate',
            'test_agent',
            'test',
            'deepseek-v4-pro-latest',
          ),
        ).not.toThrow();
      });

      test('still rejects an unlisted id when the given alias is not governed', () => {
        expect(() =>
          validateModelAllowed(
            'deepseek/deepseek-v5-pro-promoted-candidate',
            'test_agent',
            'test',
            'not-a-real-alias',
          ),
        ).toThrowError(expect.objectContaining({ code: 'MODEL_NOT_ALLOWED' }));
      });

      test('still rejects an unlisted id when no alias is provided', () => {
        expect(() =>
          validateModelAllowed('deepseek/deepseek-v5-pro-promoted-candidate', 'test_agent', 'test'),
        ).toThrowError(expect.objectContaining({ code: 'MODEL_NOT_ALLOWED' }));
      });
    });
  });

  describe('validateContract', () => {
    test('passes when contract is valid', () => {
      expect(() => validateContract(true, 'test_agent', 'test', 'gpt-5.4-mini', '')).not.toThrow();
    });

    test('throws OUTPUT_CONTRACT_VIOLATION when contract fails', () => {
      try {
        validateContract(
          false,
          'test_agent',
          'test',
          'mistral-medium-3.5',
          'Missing required fields',
        );
        expect.unreachable('Should have thrown ModelGovernanceError');
      } catch (error: any) {
        if (error.name === 'AssertionError') throw error;

        const isGovError =
          error.name === 'ModelGovernanceError' || error.code === 'OUTPUT_CONTRACT_VIOLATION';
        expect(isGovError).toBe(true);

        const govError = error as ModelGovernanceError;
        expect(govError.code).toBe('OUTPUT_CONTRACT_VIOLATION');
        expect(govError.details).toMatchObject({
          agent: 'test_agent',
          routeContext: 'test',
          modelEfetivo: 'mistral-medium-3.5',
          contract_version: CONTRACT_VERSION,
          error_code: 'OUTPUT_CONTRACT_VIOLATION',
        });
      }
    });
  });
});
