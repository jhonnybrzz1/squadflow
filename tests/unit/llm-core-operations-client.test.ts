/**
 * Testes unitários para llm-client-management-operations.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clientManagementManager } from '../../server/services/llm-core-operations';

// Mock dependencies
vi.mock('../../server/services/llm-client-manager', () => ({
  llmClientManager: {
    getClient: vi.fn(),
    hasClient: vi.fn(),
  },
}));

describe('llm-client-management-operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getClient', () => {
    it('deve obter client para provider', async () => {
      const { llmClientManager } = await import('../../server/services/llm-client-manager');
      const mockClient = {};
      vi.mocked(llmClientManager.getClient).mockReturnValue(mockClient);

      const result = clientManagementManager.getClient('openai');

      expect(result).toBe(mockClient);
      expect(llmClientManager.getClient).toHaveBeenCalledWith('openai');
    });
  });

  describe('hasClient', () => {
    it('deve verificar se client está disponível', async () => {
      const { llmClientManager } = await import('../../server/services/llm-client-manager');
      vi.mocked(llmClientManager.hasClient).mockReturnValue(true);

      const result = clientManagementManager.hasClient('openai');

      expect(result).toBe(true);
      expect(llmClientManager.hasClient).toHaveBeenCalledWith('openai');
    });
  });

  describe('getAvailableProviders', () => {
    it('deve retornar providers disponíveis', async () => {
      const { llmClientManager } = await import('../../server/services/llm-client-manager');
      vi.mocked(llmClientManager.hasClient).mockImplementation((provider) => {
        return provider === 'openai';
      });

      const result = clientManagementManager.getAvailableProviders();

      expect(result).toEqual(['openai']);
    });

    it('deve retornar array vazio quando nenhum provider disponível', async () => {
      const { llmClientManager } = await import('../../server/services/llm-client-manager');
      vi.mocked(llmClientManager.hasClient).mockReturnValue(false);

      const result = clientManagementManager.getAvailableProviders();

      expect(result).toEqual([]);
    });
  });

  describe('hasAnyClient', () => {
    it('deve retornar true quando algum client disponível', async () => {
      const { llmClientManager } = await import('../../server/services/llm-client-manager');
      vi.mocked(llmClientManager.hasClient).mockImplementation((provider) => {
        return provider === 'openai';
      });

      const result = clientManagementManager.hasAnyClient();

      expect(result).toBe(true);
    });

    it('deve retornar false quando nenhum client disponível', async () => {
      const { llmClientManager } = await import('../../server/services/llm-client-manager');
      vi.mocked(llmClientManager.hasClient).mockReturnValue(false);

      const result = clientManagementManager.hasAnyClient();

      expect(result).toBe(false);
    });
  });

  describe('getDefaultProvider', () => {
    it('deve retornar openrouter quando disponível', async () => {
      const { llmClientManager } = await import('../../server/services/llm-client-manager');
      vi.mocked(llmClientManager.hasClient).mockImplementation((provider) => {
        return provider === 'openrouter';
      });

      const result = clientManagementManager.getDefaultProvider();

      expect(result).toBe('openrouter');
    });

    it('deve retornar openai quando openrouter não disponível', async () => {
      const { llmClientManager } = await import('../../server/services/llm-client-manager');
      vi.mocked(llmClientManager.hasClient).mockImplementation((provider) => {
        return provider === 'openai';
      });

      const result = clientManagementManager.getDefaultProvider();

      expect(result).toBe('openai');
    });

    it('deve lançar erro quando nenhum client disponível', async () => {
      const { llmClientManager } = await import('../../server/services/llm-client-manager');
      vi.mocked(llmClientManager.hasClient).mockReturnValue(false);

      expect(() => {
        clientManagementManager.getDefaultProvider();
      }).toThrow('No LLM client available');
    });
  });
});
