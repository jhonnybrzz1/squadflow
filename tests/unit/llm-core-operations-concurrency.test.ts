/**
 * Testes unitários para llm-concurrency-operations.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { concurrencyManager } from '../../server/services/llm-core-operations';

// Mock dependencies
vi.mock('../../server/services/llm-utils', () => ({
  resolveConcurrency: vi.fn(),
  mapWithConcurrency: vi.fn(),
}));

describe('llm-concurrency-operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolveConcurrency', () => {
    it('deve usar valor fornecido quando válido', () => {
      const result = concurrencyManager.resolveConcurrency({ value: 5 });

      expect(result).toBe(5);
    });

    it('deve usar valor padrão quando não fornecido', () => {
      const result = concurrencyManager.resolveConcurrency({});

      expect(result).toBe(4);
    });

    it('deve usar valor padrão customizado', () => {
      const result = concurrencyManager.resolveConcurrency({ defaultValue: 8 });

      expect(result).toBe(8);
    });

    it('deve limitar ao máximo configurado', () => {
      const result = concurrencyManager.resolveConcurrency({ value: 20, maxValue: 10 });

      expect(result).toBe(10);
    });

    it('deve usar padrão quando valor inválido', () => {
      const result = concurrencyManager.resolveConcurrency({ value: -1 });

      expect(result).toBe(4);
    });

    it('deve usar padrão quando valor não finito', () => {
      const result = concurrencyManager.resolveConcurrency({ value: NaN });

      expect(result).toBe(4);
    });
  });

  describe('mapWithConcurrency', () => {
    it('deve executar map com concurrency', async () => {
      const { mapWithConcurrency } = await import('../../server/services/llm-utils');
      vi.mocked(mapWithConcurrency).mockResolvedValue([1, 2, 3]);

      const items = [1, 2, 3];
      const worker = vi.fn();

      const result = await concurrencyManager.mapWithConcurrency(items, 2, worker);

      expect(result).toEqual([1, 2, 3]);
      expect(mapWithConcurrency).toHaveBeenCalledWith(items, 2, worker);
    });
  });

  describe('determineIdealConcurrency', () => {
    it('deve retornar 1 para batch de 1 item', () => {
      const result = concurrencyManager.determineIdealConcurrency(1);

      expect(result).toBe(1);
    });

    it('deve retornar 2 para batch de 5 itens', () => {
      const result = concurrencyManager.determineIdealConcurrency(5);

      expect(result).toBe(2);
    });

    it('deve retornar 4 para batch de 10 itens', () => {
      const result = concurrencyManager.determineIdealConcurrency(10);

      expect(result).toBe(4);
    });

    it('deve retornar 6 para batch de 20 itens', () => {
      const result = concurrencyManager.determineIdealConcurrency(20);

      expect(result).toBe(6);
    });

    it('deve retornar máximo para batch grande', () => {
      const result = concurrencyManager.determineIdealConcurrency(50);

      expect(result).toBe(10);
    });
  });
});
