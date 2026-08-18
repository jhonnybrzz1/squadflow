import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'http';
import type { Duplex } from 'stream';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger';
import { wsUpgradeRejectedTotal } from '../../metrics';
import {
  refinementInteractionService,
  RefinementInteractionError,
} from '../refinement-interaction';
import { createWebSocketMessage, parseWebSocketMessage, type WebSocketMessage } from './protocol';
import { webSocketOriginPolicy } from './origin-policy';

interface WebSocketConnection {
  id: string;
  demandId: number;
  socket: WebSocket;
  connectedAt: number;
}

export class InteractiveWebSocketManager {
  private connections: Map<number, Map<string, WebSocketConnection>> = new Map();
  private server?: WebSocketServer;

  attach(server: Server): void {
    if (this.server) return;

    this.server = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '', 'http://localhost');
      const match = url.pathname.match(/^\/api\/demands\/(\d+)\/ws$/);
      // Paths não casados são pass-through: o HMR do Vite compartilha
      // este mesmo evento 'upgrade' (contrato websocket-upgrade.md).
      if (!match) return;

      const demandId = Number(match[1]);
      const origin = request.headers.origin;

      if (webSocketOriginPolicy.decide(origin) === 'reject') {
        this.rejectUpgrade(socket, 'origin', demandId);
        return;
      }

      void this.demandExists(demandId).then((exists) => {
        if (socket.destroyed) return;
        if (!exists) {
          this.rejectUpgrade(socket, 'demand_not_found', demandId);
          return;
        }
        this.server!.handleUpgrade(request, socket, head, (ws) => {
          this.server!.emit('connection', ws, request, demandId);
        });
      });
    });

    this.server.on('connection', (ws: WebSocket, _request, demandId: number) => {
      this.addConnection(demandId, ws);
    });
  }

  private rejectUpgrade(
    socket: Duplex,
    reason: 'origin' | 'demand_not_found',
    demandId: number,
  ): void {
    // Resposta uniforme, sem revelar o motivo nem a existência da demanda.
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    wsUpgradeRejectedTotal.inc({ reason });
    logger.warn('WebSocket upgrade rejeitado', { context: { demandId, reason } });
  }

  private async demandExists(demandId: number): Promise<boolean> {
    try {
      const { demandRepository } = await import('../../repositories/demand-repository');
      const demand = await demandRepository.findByIdOrNull(demandId);
      return demand !== null && demand !== undefined;
    } catch (error) {
      logger.warn('Falha ao validar demanda no upgrade WebSocket — rejeitando', {
        error: error instanceof Error ? error : undefined,
        context: { demandId },
      });
      return false;
    }
  }

  addConnection(demandId: number, socket: WebSocket): string {
    const id = randomUUID();
    const connection: WebSocketConnection = {
      id,
      demandId,
      socket,
      connectedAt: Date.now(),
    };

    if (!this.connections.has(demandId)) {
      this.connections.set(demandId, new Map());
    }
    this.connections.get(demandId)!.set(id, connection);

    socket.on('message', (raw) => {
      this.handleMessage(demandId, id, raw).catch((error) => {
        this.sendToSocket(
          socket,
          createWebSocketMessage('error', demandId, this.errorPayload(error)),
        );
      });
    });
    socket.on('close', () => this.removeConnection(demandId, id));
    socket.on('error', (error) => {
      logger.warn('Interactive WebSocket error', {
        error,
        context: { demandId, connectionId: id },
      });
    });

    this.sendToSocket(socket, createWebSocketMessage('hello', demandId, { connectionId: id }));
    this.sendStatus(demandId).catch((error) =>
      logger.warn('Failed to send initial WebSocket status', {
        error: error instanceof Error ? error : undefined,
        context: { demandId },
      }),
    );

    return id;
  }

  removeConnection(demandId: number, connectionId: string): void {
    const demandConnections = this.connections.get(demandId);
    if (!demandConnections) return;
    demandConnections.delete(connectionId);
    if (demandConnections.size === 0) {
      this.connections.delete(demandId);
    }
  }

  broadcastToDemand(
    demandId: number,
    type: WebSocketMessage['type'],
    data: Record<string, unknown>,
  ): void {
    const message = createWebSocketMessage(type, demandId, data);
    for (const connection of this.connections.get(demandId)?.values() ?? []) {
      this.sendToSocket(connection.socket, message);
    }
  }

  getActiveConnectionCount(): number {
    let count = 0;
    for (const connections of this.connections.values()) {
      count += connections.size;
    }
    return count;
  }

  private async handleMessage(demandId: number, connectionId: string, raw: unknown): Promise<void> {
    const message = parseWebSocketMessage(raw);
    const refinementId = String(demandId);

    // FR-002A: a conexão fica vinculada à demanda do path do upgrade.
    // Payload referenciando outra demanda é ignorado sem ack.
    const payloadDemand = message.demandId ?? message.data?.demandId ?? message.data?.refinementId;
    if (payloadDemand !== undefined && String(payloadDemand) !== String(demandId)) {
      logger.warn('Comando WebSocket para demanda fora do escopo da conexão — ignorado', {
        context: { demandId, connectionId, targetDemand: String(payloadDemand) },
      });
      return;
    }

    if (message.type === 'pong') return;

    if (message.type === 'status') {
      await this.sendStatus(demandId);
      return;
    }

    if (message.type === 'pause') {
      const reason = typeof message.data.reason === 'string' ? message.data.reason : undefined;
      const result = await refinementInteractionService.pause(refinementId, reason);
      this.broadcastToDemand(demandId, 'ack', { action: 'pause', ...result });
      await this.sendStatus(demandId);
      return;
    }

    if (message.type === 'resume') {
      const result = await refinementInteractionService.resume(refinementId);
      this.broadcastToDemand(demandId, 'ack', { action: 'resume', ...result });
      await this.sendStatus(demandId);
      return;
    }

    if (message.type === 'answer') {
      const interactionId = String(message.data.interactionId || message.data.questionId || '');
      const sequence = Number(message.data.sequence ?? message.data.awaitingToken);
      const answer = String(message.data.answer ?? message.data.value ?? '');
      const result = await refinementInteractionService.applyResponse(
        refinementId,
        interactionId,
        sequence,
        answer,
      );
      this.broadcastToDemand(demandId, 'ack', { action: 'answer', ...result });
      await this.sendStatus(demandId);
      return;
    }

    logger.debug('Ignored interactive WebSocket message', {
      context: { demandId, connectionId, type: message.type },
    });
  }

  private async sendStatus(demandId: number): Promise<void> {
    const status = await refinementInteractionService.getStatus(String(demandId));
    this.broadcastToDemand(demandId, 'status', status as unknown as Record<string, unknown>);
    if (status.activeInteraction) {
      this.broadcastToDemand(
        demandId,
        'question',
        status.activeInteraction as unknown as Record<string, unknown>,
      );
    }
    for (const suggestion of status.suggestions) {
      this.broadcastToDemand(
        demandId,
        'suggestion',
        suggestion as unknown as Record<string, unknown>,
      );
    }
  }

  private sendToSocket(socket: WebSocket, message: WebSocketMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  private errorPayload(error: unknown): Record<string, unknown> {
    if (error instanceof RefinementInteractionError) {
      return {
        code: error.code,
        message: error.message,
        statusCode: error.statusCode,
        currentSequence: error.currentSequence ?? null,
      };
    }
    return {
      code: 'WEBSOCKET_ERROR',
      message: error instanceof Error ? error.message : 'Unexpected WebSocket error',
    };
  }
}

export const interactiveWebSocketManager = new InteractiveWebSocketManager();
