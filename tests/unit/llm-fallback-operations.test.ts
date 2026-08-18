/**
 * Testes unitários para o rate limiter consolidado em llm-routing.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FallbackManager } from '../../server/services/llm-routing';

// Mock dependencies
vi.mock('../../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('llm-routing fallback limiter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkAndRecordFallback', () => {
    it('deve permitir fallback quando abaixo do limite', () => {
      const manager = new FallbackManager();
      const result = manager.checkAndRecordFallback();
      expect(result).toBe(true);
    });

    it('deve bloquear fallback quando acima do limite', () => {
      const manager = new FallbackManager();
      // Exceder limite de 5 fallbacks em 60 segundos
      for (let i = 0; i < 6; i++) {
        manager.checkAndRecordFallback();
      }

      const result = manager.checkAndRecordFallback();
      expect(result).toBe(false);
    });
  });
});
