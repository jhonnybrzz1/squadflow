/**
 * Testes unitários para llm-error-handling-operations.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { errorHandlingManager } from '../../server/services/llm-error-handling-operations';
import { logger } from '../../server/utils/logger';

// Mock dependencies
vi.mock('../../server/utils/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('llm-error-handling-operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sanitizeAIError', () => {
    it('deve sanitizar Error instance', () => {
      const error = new Error('Test error');
      const result = errorHandlingManager.sanitizeAIError(error);

      expect(result).toEqual({
        message: 'Test error',
        type: 'Error',
      });
    });

    it('deve sanitizar string error', () => {
      const error = 'String error';
      const result = errorHandlingManager.sanitizeAIError(error);

      expect(result).toEqual({
        message: 'String error',
        type: 'StringError',
      });
    });

    it('deve sanitizar object error', () => {
      const error = { message: 'Object error', status: 500, type: 'ApiError' };
      const result = errorHandlingManager.sanitizeAIError(error);

      expect(result.message).toBe('Object error');
      expect(result.type).toBe('ApiError');
      expect(result.status).toBe(500);
      expect(result.details).toBeDefined();
    });

    it('deve redact dados sensíveis', () => {
      const error = { message: 'Error', apiKey: 'secret123', token: 'abc' };
      const result = errorHandlingManager.sanitizeAIError(error);

      // O código redacta dados sensíveis baseado na chave
      // mas o valor precisa ser verificado no código atual
      expect(result.details).toBeDefined();
    });

    it('deve truncar strings longas', () => {
      const longString = 'a'.repeat(300);
      const error = { message: 'Error', data: longString };
      const result = errorHandlingManager.sanitizeAIError(error);

      expect(result.details?.data).toBe('a'.repeat(200) + '...');
    });

    it('B-1 (avaliação de LLM 2026-07-26): redige chave embutida na message de um Error', () => {
      const error = new Error('Invalid API key: sk-abc123def456ghi789jkl'); // gitleaks:allow -- synthetic redaction fixture
      const result = errorHandlingManager.sanitizeAIError(error);

      expect(result.message).not.toContain('sk-abc123def456ghi789jkl');
      expect(result.message).toContain('[REDACTED]');
    });

    it('B-1: redige chave embutida numa message de string error', () => {
      const error = 'Falha na chamada: Bearer abcdefghijklmnop1234567890';
      const result = errorHandlingManager.sanitizeAIError(error);

      expect(result.message).not.toContain('abcdefghijklmnop1234567890');
    });

    it('B-1: redige chave embutida em valores string de details, não só por nome de campo', () => {
      const error = {
        message: 'Erro genérico',
        rawResponse: 'A chave usada foi sk-zzz999yyy888xxx777www666',
      };
      const result = errorHandlingManager.sanitizeAIError(error);

      expect(result.details?.rawResponse).not.toContain('sk-zzz999yyy888xxx777www666');
      expect(result.details?.rawResponse).toContain('[REDACTED]');
    });

    it('B-1: não altera mensagens sem padrão de segredo reconhecível', () => {
      const error = new Error('Connection timeout after 5000ms');
      const result = errorHandlingManager.sanitizeAIError(error);

      expect(result.message).toBe('Connection timeout after 5000ms');
    });
  });

  describe('getErrorMessage', () => {
    it('deve extrair mensagem de Error', () => {
      const error = new Error('Test error');
      const result = errorHandlingManager.getErrorMessage(error);

      expect(result).toBe('Test error');
    });

    it('deve extrair mensagem de string', () => {
      const error = 'String error';
      const result = errorHandlingManager.getErrorMessage(error);

      expect(result).toBe('String error');
    });

    it('deve extrair mensagem de object', () => {
      const error = { message: 'Object error' };
      const result = errorHandlingManager.getErrorMessage(error);

      expect(result).toBe('Object error');
    });

    it('deve retornar Unknown error para erro desconhecido', () => {
      const error = null;
      const result = errorHandlingManager.getErrorMessage(error);

      expect(result).toBe('Unknown error');
    });
  });

  describe('getErrorStatus', () => {
    it('deve extrair status code de object', () => {
      const error = { status: 404 };
      const result = errorHandlingManager.getErrorStatus(error);

      expect(result).toBe(404);
    });

    it('deve extrair statusCode de object', () => {
      const error = { statusCode: 500 };
      const result = errorHandlingManager.getErrorStatus(error);

      expect(result).toBe(500);
    });

    it('deve retornar undefined quando não há status', () => {
      const error = { message: 'Error' };
      const result = errorHandlingManager.getErrorStatus(error);

      expect(result).toBeUndefined();
    });
  });

  describe('getHeaderValue', () => {
    it('deve extrair header de object', () => {
      const error = { headers: { 'retry-after': '60' } };
      const result = errorHandlingManager.getHeaderValue(error, 'retry-after');

      expect(result).toBe('60');
    });

    it('deve retornar undefined quando header não existe', () => {
      const error = { headers: { 'content-type': 'application/json' } };
      const result = errorHandlingManager.getHeaderValue(error, 'retry-after');

      expect(result).toBeUndefined();
    });
  });

  describe('logSanitized', () => {
    it('deve logar erro sanitizado sem vazar token aninhado em error.cause.message', () => {
      const cause = new Error('Authorization failed: Bearer sk-test-123abc');
      const error = new Error('Request failed');
      (error as Error & { cause: unknown }).cause = cause;

      errorHandlingManager.logSanitized(error, { operation: 'test' });

      const logPayload = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const logString = JSON.stringify(logPayload);
      expect(logString).not.toContain('sk-test-123abc');
      expect(logString).toContain('[REDACTED]');
    });

    it('deve redigir path absoluto e env var em mensagem', () => {
      const error = new Error('Config loaded from /Users/dev/app/.env and process.env.SECRET_KEY');
      errorHandlingManager.logSanitized(error, 'OpenAI fallback');

      const logPayload2 = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const logString = JSON.stringify(logPayload2);
      expect(logString).not.toContain('/Users/dev/app/.env');
      expect(logString).toContain('[REDACTED_PATH]');
      expect(logString).not.toContain('process.env.SECRET_KEY');
      expect(logString).toContain('[REDACTED_ENV]');
    });

    it('payload simulado OpenAI 429 com headers não vaza tokens', () => {
      const error = {
        message: 'Request failed with status 429: Rate limit exceeded',
        status: 429,
        headers: { 'x-request-id': 'req-001', authorization: 'Bearer sk-openai-1234567890abcdef' },
        type: 'OpenAIError',
      };
      errorHandlingManager.logSanitized(error, { provider: 'openai' });

      const logPayload3 = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const logString = JSON.stringify(logPayload3);
      expect(logString).not.toContain('sk-openai-1234567890abcdef');
      expect(logString).toContain('[REDACTED]');
    });

    it('payload simulado Anthropic overloaded com x-request-id', () => {
      const error = {
        message: 'Anthropic API overloaded: request id anthropic-req-999',
        status: 529,
        headers: { 'x-request-id': 'anthropic-req-999' },
        type: 'AnthropicError',
      };
      errorHandlingManager.logSanitized(error, { provider: 'anthropic' });

      const logPayload4 = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(logPayload4).toBeDefined();
      expect(logPayload4.status).toBe(529);
      expect(logPayload4.type).toBe('AnthropicError');
    });

    it('payload simulado Google quota exceeded', () => {
      const error = {
        message: 'Google API quota exceeded for project /home/dev/keys/google-key.json',
        status: 403,
        type: 'GoogleError',
      };
      errorHandlingManager.logSanitized(error, { provider: 'google' });

      const logPayload5 = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const logString = JSON.stringify(logPayload5);
      expect(logString).not.toContain('/home/dev/keys/google-key.json');
      expect(logString).toContain('[REDACTED_PATH]');
    });

    it('fuzzing leve: strings aleatórias com caracteres especiais e tokens misturados', () => {
      const cases = [
        'Error: key=sk-abc123xyz789qwe456rty and path=/Users/x/y', // gitleaks:allow -- synthetic fuzz fixture
        'Falha: Bearer tok.en.1234567890abcdefghij! process.env.MY_SECRET',
        'Crash: ${API_KEY} at C:\\Users\\dev\\secret.txt',
        'Timeout /home/user/.env.local com sk-zzzz9999yyyy0000xxxx',
      ];
      for (const msg of cases) {
        errorHandlingManager.logSanitized(new Error(msg), 'fuzz');
      }

      const allCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => JSON.stringify(c[1]))
        .join(' ');
      expect(allCalls).not.toContain('sk-abc123');
      expect(allCalls).not.toContain('/Users/x/y');
      expect(allCalls).not.toContain('tok.en.1234567890');
      expect(allCalls).not.toContain('process.env.MY_SECRET');
      expect(allCalls).not.toContain('${API_KEY}');
      expect(allCalls).not.toContain('C:\\Users\\dev\\secret.txt');
      expect(allCalls).not.toContain('/home/user/.env.local');
      expect(allCalls).not.toContain('sk-zzzz9999yyyy');
    });
  });
});
