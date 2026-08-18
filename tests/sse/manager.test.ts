/**
 * SSE Manager Tests - Testes para o gerenciador de SSE
 * Cobertura: Happy path, múltiplas conexões, desconexão, erros
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { SSEManager } from '../../server/services/sse/manager';
import { SSEProtocolValidator } from '../../server/services/sse/protocol';
import type { SSEEvent } from '../../server/services/sse/protocol';

// Mock do logger
vi.mock('../../server/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock do metricsCollector
vi.mock('../../server/metrics/collector', () => ({
  metricsCollector: {
    recordSSEFirstEvent: vi.fn(),
    recordSSEEvent: vi.fn(),
    recordSSEConnectionEnd: vi.fn(),
  },
}));

describe('SSEManager', () => {
  let sseManager: SSEManager;
  let mockResponse: any;

  beforeEach(() => {
    sseManager = new SSEManager();

    // Mock response object
    mockResponse = {
      write: vi.fn(),
      end: vi.fn(),
    };
  });

  afterEach(() => {
    sseManager.shutdown();
  });

  describe('Happy Path', () => {
    test('deve adicionar e remover conexão SSE', () => {
      const demandId = 1;
      const connectionId = sseManager.addConnection(demandId, mockResponse);

      expect(connectionId).toBeDefined();
      expect(typeof connectionId).toBe('string');

      const connections = sseManager.getConnections(demandId);
      expect(connections).toHaveLength(1);
      expect(connections[0].id).toBe(connectionId);

      sseManager.removeConnection(demandId, connectionId);

      const connectionsAfter = sseManager.getConnections(demandId);
      expect(connectionsAfter).toHaveLength(0);
    });

    test('deve enviar evento started', () => {
      const demandId = 1;
      sseManager.addConnection(demandId, mockResponse);

      sseManager.sendStarted(demandId, { message: 'Test started' });

      expect(mockResponse.write).toHaveBeenCalled();
      const writtenData = mockResponse.write.mock.calls[0][0];
      expect(writtenData).toContain('event: started');
      expect(writtenData).toContain('Test started');
    });

    test('deve enviar evento processing', () => {
      const demandId = 1;
      sseManager.addConnection(demandId, mockResponse);

      sseManager.sendProcessing(demandId, { message: 'Processing' });

      expect(mockResponse.write).toHaveBeenCalled();
      const writtenData = mockResponse.write.mock.calls[0][0];
      expect(writtenData).toContain('event: processing');
    });

    test('deve enviar evento progress', () => {
      const demandId = 1;
      sseManager.addConnection(demandId, mockResponse);

      sseManager.sendProgress(demandId, 50, { message: '50% complete' });

      expect(mockResponse.write).toHaveBeenCalled();
      const writtenData = mockResponse.write.mock.calls[0][0];
      expect(writtenData).toContain('progress');
      expect(writtenData).toContain('50');
    });

    test('deve enviar evento completed', () => {
      const demandId = 1;
      sseManager.addConnection(demandId, mockResponse);

      sseManager.sendCompleted(demandId, { message: 'Completed' });

      expect(mockResponse.write).toHaveBeenCalled();
      const writtenData = mockResponse.write.mock.calls[0][0];
      expect(writtenData).toContain('event: completed');
    });

    test('deve enviar evento error', () => {
      const demandId = 1;
      sseManager.addConnection(demandId, mockResponse);

      sseManager.sendError(demandId, 'TEST_ERROR', 'Test error message', false);

      expect(mockResponse.write).toHaveBeenCalled();
      const writtenData = mockResponse.write.mock.calls[0][0];
      expect(writtenData).toContain('event: error');
      expect(writtenData).toContain('TEST_ERROR');
      expect(writtenData).toContain('Test error message');
    });
  });

  describe('Múltiplas Conexões', () => {
    test('deve suportar 10+ conexões simultâneas', () => {
      const demandId = 1;
      const connectionCount = 10;
      const mockResponses = Array.from({ length: connectionCount }, () => ({
        write: vi.fn(),
        end: vi.fn(),
      }));

      const connectionIds: string[] = [];
      mockResponses.forEach((res) => {
        const id = sseManager.addConnection(demandId, res);
        connectionIds.push(id);
      });

      expect(sseManager.getConnections(demandId)).toHaveLength(connectionCount);
      expect(sseManager.getActiveConnectionCount()).toBe(connectionCount);

      // Enviar evento para todas as conexões
      sseManager.sendStarted(demandId);

      mockResponses.forEach((res) => {
        expect(res.write).toHaveBeenCalled();
      });

      // Remover todas as conexões
      connectionIds.forEach((id) => {
        sseManager.removeConnection(demandId, id);
      });

      expect(sseManager.getConnections(demandId)).toHaveLength(0);
    });

    test('deve suportar 50+ conexões simultâneas', () => {
      const demandId = 1;
      const connectionCount = 50;
      const mockResponses = Array.from({ length: connectionCount }, () => ({
        write: vi.fn(),
        end: vi.fn(),
      }));

      mockResponses.forEach((res) => {
        sseManager.addConnection(demandId, res);
      });

      expect(sseManager.getActiveConnectionCount()).toBe(connectionCount);

      // Enviar eventos múltiplos
      sseManager.sendStarted(demandId);
      sseManager.sendProcessing(demandId);
      sseManager.sendProgress(demandId, 25);

      expect(sseManager.getActiveConnectionCount()).toBe(connectionCount);

      // Limpar
      sseManager.removeConnection(demandId);
    });
  });

  describe('Desconexão Abrupta', () => {
    test('deve lidar com desconexão durante envio de evento', () => {
      const demandId = 1;
      const errorResponse = {
        write: vi.fn(() => {
          throw new Error('Connection closed');
        }),
        end: vi.fn(),
      };

      sseManager.addConnection(demandId, errorResponse);

      // Não deve lançar erro
      expect(() => {
        sseManager.sendStarted(demandId);
      }).not.toThrow();

      // Conexão deve ser marcada como inativa
      const connections = sseManager.getConnections(demandId);
      expect(connections[0].isActive).toBe(false);
    });

    test('deve remover conexões inativas automaticamente', () => {
      const demandId = 1;
      const errorResponse = {
        write: vi.fn(() => {
          throw new Error('Connection closed');
        }),
        end: vi.fn(),
      };

      sseManager.addConnection(demandId, errorResponse);

      // Enviar evento para marcar como inativa
      sseManager.sendStarted(demandId);

      // Forçar cleanup
      const privateManager = sseManager as any;
      if (privateManager.cleanupInactiveConnections) {
        privateManager.cleanupInactiveConnections();
      }

      const connections = sseManager.getConnections(demandId);
      expect(connections).toHaveLength(0);
    });
  });

  describe('Validação de Sequência', () => {
    test('deve validar sequência correta: started -> completed', () => {
      const demandId = 1;
      sseManager.addConnection(demandId, mockResponse);

      sseManager.sendStarted(demandId);
      sseManager.sendCompleted(demandId);

      const validation = sseManager.validateSequence(demandId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    test('deve validar sequência correta: started -> processing -> completed', () => {
      const demandId = 1;
      sseManager.addConnection(demandId, mockResponse);

      sseManager.sendStarted(demandId);
      sseManager.sendProcessing(demandId);
      sseManager.sendCompleted(demandId);

      const validation = sseManager.validateSequence(demandId);
      expect(validation.valid).toBe(true);
    });

    test('deve validar sequência com erro: started -> error', () => {
      const demandId = 1;
      sseManager.addConnection(demandId, mockResponse);

      sseManager.sendStarted(demandId);
      sseManager.sendError(demandId, 'TEST_ERROR', 'Test error', false);

      const validation = sseManager.validateSequence(demandId);
      expect(validation.valid).toBe(true);
    });

    test('deve rejeitar sequência sem started', () => {
      const events: SSEEvent[] = [
        {
          type: 'processing',
          timestamp: Date.now(),
          demandId: 1,
        },
      ];

      const validation = SSEProtocolValidator.validateSequence(events);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("First event must be 'started', got 'processing'");
    });

    test('deve rejeitar sequência sem evento terminal', () => {
      const events: SSEEvent[] = [
        {
          type: 'started',
          timestamp: Date.now(),
          demandId: 1,
        },
        {
          type: 'processing',
          timestamp: Date.now(),
          demandId: 1,
        },
      ];

      const validation = SSEProtocolValidator.validateSequence(events);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.includes('Last event must be'))).toBe(true);
    });
  });

  describe('Contagem de Conexões', () => {
    test('deve retornar contagem correta de conexões ativas', () => {
      const demandId1 = 1;
      const demandId2 = 2;

      sseManager.addConnection(demandId1, { write: vi.fn(), end: vi.fn() });
      sseManager.addConnection(demandId1, { write: vi.fn(), end: vi.fn() });
      sseManager.addConnection(demandId2, { write: vi.fn(), end: vi.fn() });

      expect(sseManager.getActiveConnectionCount()).toBe(3);

      sseManager.removeConnection(demandId1);
      sseManager.removeConnection(demandId2);

      expect(sseManager.getActiveConnectionCount()).toBe(0);
    });
  });

  describe('Limpeza de Recursos', () => {
    test('deve limpar todas as conexões no shutdown', () => {
      const demandId = 1;
      sseManager.addConnection(demandId, mockResponse);
      sseManager.addConnection(demandId, mockResponse);

      expect(sseManager.getActiveConnectionCount()).toBe(2);

      sseManager.shutdown();

      expect(sseManager.getActiveConnectionCount()).toBe(0);
    });

    test('deve limpar histórico de eventos', () => {
      const demandId = 1;
      sseManager.addConnection(demandId, mockResponse);

      sseManager.sendStarted(demandId);
      sseManager.sendCompleted(demandId);

      sseManager.clearHistory(demandId);

      const validation = sseManager.validateSequence(demandId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });
  });
});
