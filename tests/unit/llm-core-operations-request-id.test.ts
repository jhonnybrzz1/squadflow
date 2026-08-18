/**
 * Testes unitários para llm-request-id-operations.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { requestIdManager } from '../../server/services/llm-core-operations';

describe('llm-request-id-operations', () => {
  beforeEach(() => {
    requestIdManager.resetCounter();
  });

  describe('generateRequestId', () => {
    it('deve gerar request ID único', () => {
      const id1 = requestIdManager.generateRequestId();
      const id2 = requestIdManager.generateRequestId();

      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^req_\d+_[a-z0-9]+_\d+$/);
    });

    it('deve incrementar contador', () => {
      const id1 = requestIdManager.generateRequestId();
      const id2 = requestIdManager.generateRequestId();

      const counter1 = parseInt(id1.split('_').pop() || '0', 10);
      const counter2 = parseInt(id2.split('_').pop() || '0', 10);

      expect(counter2).toBe(counter1 + 1);
    });
  });

  describe('generateRequestIdWithPrefix', () => {
    it('deve gerar request ID com prefixo', () => {
      const id = requestIdManager.generateRequestIdWithPrefix('test');

      expect(id).toMatch(/^test_req_\d+_[a-z0-9]+_\d+$/);
    });
  });

  describe('isValidRequestId', () => {
    it('deve validar request ID válido', () => {
      const id = requestIdManager.generateRequestId();
      const result = requestIdManager.isValidRequestId(id);

      expect(result).toBe(true);
    });

    it('deve rejeitar request ID inválido', () => {
      const result = requestIdManager.isValidRequestId('invalid_id');

      expect(result).toBe(false);
    });

    it('deve rejeitar string vazia', () => {
      const result = requestIdManager.isValidRequestId('');

      expect(result).toBe(false);
    });
  });

  describe('extractTimestamp', () => {
    it('deve extrair timestamp de request ID válido', () => {
      const id = requestIdManager.generateRequestId();
      const timestamp = requestIdManager.extractTimestamp(id);

      expect(timestamp).not.toBeNull();
      expect(typeof timestamp).toBe('number');
      expect(timestamp).toBeGreaterThan(0);
    });

    it('deve retornar null para request ID inválido', () => {
      const timestamp = requestIdManager.extractTimestamp('invalid_id');

      expect(timestamp).toBeNull();
    });
  });

  describe('resetCounter', () => {
    it('deve resetar contador', () => {
      requestIdManager.generateRequestId();
      requestIdManager.generateRequestId();
      requestIdManager.resetCounter();

      const id = requestIdManager.generateRequestId();
      const counter = parseInt(id.split('_').pop() || '0', 10);

      expect(counter).toBe(1);
    });
  });
});
