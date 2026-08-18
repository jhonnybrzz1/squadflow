/**
 * SSE Manager - Gerenciador de Conexões Server-Sent Events
 * Responsável por gerenciar conexões SSE, enviar eventos e manter estado
 *
 * Funcionalidades:
 * - Gerenciar múltiplas conexões SSE por demandId
 * - Enviar eventos com protocolo validado
 * - Controlar heartbeat e timeouts
 * - Limpar conexões mortas
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger';
import { metricsCollector } from '../../metrics/collector';
import {
  SSEConnection,
  SSEEvent,
  SSEEventType,
  SSEProtocolValidator,
  SSE_CONFIG,
} from './protocol';

export class SSEManager {
  private connections: Map<number, SSEConnection[]> = new Map();
  private heartbeatInterval?: NodeJS.Timeout;
  private eventHistory: Map<number, SSEEvent[]> = new Map(); // Para validação de contrato

  constructor() {
    this.startHeartbeat();
  }

  /**
   * Adiciona uma nova conexão SSE
   */
  addConnection(demandId: number, res: SSEConnection['res']): string {
    const connectionId = uuidv4();
    const now = Date.now();

    const connection: SSEConnection = {
      id: connectionId,
      demandId,
      res,
      startTime: now,
      firstEventTime: null,
      eventCount: 0,
      lastEventTime: null,
      isActive: true,
    };

    // Adicionar ao mapa de conexões
    if (!this.connections.has(demandId)) {
      this.connections.set(demandId, []);
    }
    this.connections.get(demandId)!.push(connection);

    // Inicializar histórico de eventos para validação
    if (!this.eventHistory.has(demandId)) {
      this.eventHistory.set(demandId, []);
    }

    logger.debug('SSE connection added', {
      context: { demandId, connectionId, totalConnections: this.connections.size },
    });

    return connectionId;
  }

  /**
   * Remove uma conexão SSE
   */
  removeConnection(demandId: number, connectionId?: string): void {
    const connections = this.connections.get(demandId);
    if (!connections) return;

    if (connectionId) {
      const index = connections.findIndex((c) => c.id === connectionId);
      if (index !== -1) {
        const connection = connections[index];
        connection.isActive = false;
        connections.splice(index, 1);

        // Registrar fim da conexão nas métricas
        if (connection.firstEventTime) {
          metricsCollector.recordSSEConnectionEnd(demandId);
        }
      }
    } else {
      // Remover todas as conexões para este demandId
      connections.forEach((conn) => {
        conn.isActive = false;
        if (conn.firstEventTime) {
          metricsCollector.recordSSEConnectionEnd(demandId);
        }
      });
      connections.length = 0;
    }

    // Limpar se não houver mais conexões
    if (connections.length === 0) {
      this.connections.delete(demandId);
    }

    logger.debug('SSE connection removed', {
      context: { demandId, connectionId, remainingConnections: this.connections.size },
    });
  }

  /**
   * Envia um evento para uma conexão específica
   */
  sendEvent(
    eventType: SSEEventType,
    demandId: number,
    data?: Record<string, unknown>,
    error?: { code: string; message: string; retriable: boolean },
    options?: { operationId?: string; agent_id?: string; metadata?: Record<string, unknown> },
  ): void {
    const connections = this.connections.get(demandId);
    if (!connections || connections.length === 0) {
      return;
    }

    // Criar evento validado
    const event = SSEProtocolValidator.createEvent(
      eventType,
      demandId,
      data,
      error,
      options?.operationId,
      options?.agent_id,
      options?.metadata,
    );

    // Adicionar ao histórico para validação
    const history = this.eventHistory.get(demandId);
    if (history) {
      history.push(event);
    }

    // Serializar evento
    const serializedEvent = SSEProtocolValidator.serialize(event);

    // Enviar para todas as conexões ativas
    connections.forEach((connection) => {
      if (!connection.isActive) return;

      try {
        connection.res.write(serializedEvent);
        if (typeof connection.res.flush === 'function') {
          connection.res.flush();
        }

        // Atualizar estatísticas da conexão
        connection.eventCount++;
        connection.lastEventTime = Date.now();

        // Registrar primeiro evento nas métricas
        if (connection.firstEventTime === null) {
          connection.firstEventTime = Date.now();
          const firstEventLatency = connection.firstEventTime - connection.startTime;
          metricsCollector.recordSSEFirstEvent(demandId, firstEventLatency);
        }

        // Registrar evento nas métricas
        metricsCollector.recordSSEEvent(demandId);

        logger.debug('SSE event sent', {
          context: {
            demandId,
            connectionId: connection.id,
            eventType,
            eventCount: connection.eventCount,
          },
        });
      } catch (err) {
        logger.error('Failed to send SSE event', {
          error: err instanceof Error ? err : undefined,
          context: { demandId, connectionId: connection.id, eventType },
        });

        // Marcar conexão como inativa se houver erro
        connection.isActive = false;
      }
    });
  }

  /**
   * Envia evento 'started' (primeiro evento obrigatório)
   */
  sendStarted(demandId: number, data?: Record<string, unknown>): void {
    this.sendEvent('started', demandId, data);
  }

  /**
   * Envia evento 'processing' (antes de trabalho pesado)
   */
  sendProcessing(demandId: number, data?: Record<string, unknown>): void {
    this.sendEvent('processing', demandId, data);
  }

  /**
   * Envia evento 'progress' (atualização de progresso)
   */
  sendProgress(demandId: number, progress: number, data?: Record<string, unknown>): void {
    this.sendEvent('progress', demandId, { progress, ...data });
  }

  /**
   * Envia evento 'completed' (evento terminal de sucesso)
   */
  sendCompleted(demandId: number, data?: Record<string, unknown>): void {
    this.sendEvent('completed', demandId, data);

    // Validar sequência após evento terminal
    this.validateSequence(demandId);
  }

  /**
   * Envia evento 'error' (evento terminal de erro)
   */
  sendError(
    demandId: number,
    code: string,
    message: string,
    retriable: boolean = false,
    data?: Record<string, unknown>,
  ): void {
    this.sendEvent('error', demandId, data, { code, message, retriable });

    // Validar sequência após evento terminal
    this.validateSequence(demandId);
  }

  /**
   * Envia chunk de streaming de agente (texto incremental)
   */
  sendAgentChunk(
    demandId: number,
    agentName: string,
    chunk: string,
    data?: Record<string, unknown>,
    options?: { operationId?: string; agent_id?: string },
  ): void {
    this.sendEvent(
      'agent_chunk',
      demandId,
      { agent: agentName, chunk, ...data },
      undefined,
      options,
    );
  }

  /**
   * Envia fragmento de raciocínio (reasoning tokens) de um agente
   */
  sendAgentReasoningChunk(
    demandId: number,
    agentName: string,
    chunk: string,
    data?: Record<string, unknown>,
    options?: { operationId?: string; agent_id?: string },
  ): void {
    this.sendEvent(
      'agent_reasoning_chunk',
      demandId,
      { agent: agentName, chunk, ...data },
      undefined,
      options,
    );
  }

  /**
   * Envia evento de input required (pausa para interação do usuário)
   */
  sendInputRequired(
    demandId: number,
    agentName: string,
    metadata: Record<string, unknown>,
    options?: { operationId?: string; agent_id?: string },
  ): void {
    this.sendEvent('input_required', demandId, { agent: agentName }, undefined, {
      ...options,
      metadata,
    });
  }

  /**
   * Envia evento de fim de stream de agente
   */
  sendAgentStreamEnd(demandId: number, agentName: string, data?: Record<string, unknown>): void {
    this.sendEvent('agent_stream_end', demandId, { agent: agentName, ...data });
  }

  /**
   * Envia evento de mesa redonda (PRD #5)
   */
  sendRoundtableEvent(
    demandId: number,
    type:
      | 'roundtable_round_start'
      | 'roundtable_agent_start'
      | 'roundtable_agent_token'
      | 'roundtable_agent_message'
      | 'roundtable_agent_done'
      | 'roundtable_divergence'
      | 'roundtable_complete'
      | 'agent_failed'
      // Demanda 10081 parte B: agente acionado no meio do refinamento.
      | 'roundtable_agent_joined',
    payload: Record<string, unknown>,
  ): void {
    this.sendEvent(type as SSEEventType, demandId, payload);
  }

  /**
   * Obtém conexões ativas para um demandId
   */
  getConnections(demandId: number): SSEConnection[] {
    return this.connections.get(demandId) || [];
  }

  /**
   * Obtém número de conexões ativas
   */
  getActiveConnectionCount(): number {
    let count = 0;
    this.connections.forEach((conns) => {
      count += conns.filter((c) => c.isActive).length;
    });
    return count;
  }

  /**
   * Valida sequência de eventos para um demandId
   */
  validateSequence(demandId: number): {
    valid: boolean;
    errors: string[];
  } {
    const history = this.eventHistory.get(demandId);
    if (!history) {
      return { valid: true, errors: [] };
    }

    const validation = SSEProtocolValidator.validateSequence(history);

    if (!validation.valid) {
      logger.warn('SSE sequence validation failed', {
        context: { demandId, errors: validation.errors },
      });
    }

    return validation;
  }

  /**
   * Limpa histórico de eventos para um demandId
   */
  clearHistory(demandId: number): void {
    this.eventHistory.delete(demandId);
  }

  /**
   * Inicia heartbeat para manter conexões vivas
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, SSE_CONFIG.HEARTBEAT_INTERVAL);
  }

  /**
   * Envia heartbeat para todas as conexões ativas
   */
  private sendHeartbeat(): void {
    const now = Date.now();

    this.connections.forEach((connections, demandId) => {
      connections.forEach((connection) => {
        if (!connection.isActive) return;

        // Verificar timeout
        if (now - connection.lastEventTime! > SSE_CONFIG.CONNECTION_TIMEOUT) {
          logger.warn('SSE connection timeout', {
            context: {
              demandId,
              connectionId: connection.id,
              idleTime: now - connection.lastEventTime!,
            },
          });
          this.removeConnection(demandId, connection.id);
          return;
        }

        // Enviar comentário de heartbeat (mantém conexão viva sem evento)
        try {
          connection.res.write(': heartbeat\n\n');
        } catch (err) {
          logger.error('Failed to send heartbeat', {
            error: err instanceof Error ? err : undefined,
            context: { demandId, connectionId: connection.id },
          });
          connection.isActive = false;
        }
      });
    });

    // Limpar conexões inativas
    this.cleanupInactiveConnections();
  }

  /**
   * Remove conexões inativas
   */
  private cleanupInactiveConnections(): void {
    this.connections.forEach((connections, demandId) => {
      const activeConnections = connections.filter((c) => c.isActive);

      if (activeConnections.length !== connections.length) {
        this.connections.set(demandId, activeConnections);
        logger.debug('Cleaned up inactive SSE connections', {
          context: {
            demandId,
            removed: connections.length - activeConnections.length,
            remaining: activeConnections.length,
          },
        });
      }

      if (activeConnections.length === 0) {
        this.connections.delete(demandId);
      }
    });
  }

  /**
   * Para o heartbeat e limpa recursos
   */
  shutdown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Fechar todas as conexões
    this.connections.forEach((connections, _demandId) => {
      connections.forEach((connection) => {
        try {
          connection.res.end();
        } catch (_err) {
          // Ignorar erros ao fechar
        }
      });
    });

    this.connections.clear();
    this.eventHistory.clear();

    logger.info('SSE manager shutdown complete');
  }
}

// Singleton instance
export const sseManager = new SSEManager();

// Cleanup on process exit
process.on('SIGTERM', () => {
  sseManager.shutdown();
});

process.on('SIGINT', () => {
  sseManager.shutdown();
});
