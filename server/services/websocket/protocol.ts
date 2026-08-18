import { z } from 'zod';
import { logger } from '../../utils/logger';

export const websocketMessageSchema = z.object({
  type: z.enum([
    'hello',
    'status',
    'answer',
    'pause',
    'resume',
    'progress',
    'question',
    'suggestion',
    'error',
    'ack',
    'pong',
  ]),
  demandId: z.number().int().positive().optional(),
  timestamp: z.string().optional(),
  data: z.record(z.unknown()).default({}),
});

export type WebSocketMessage = z.infer<typeof websocketMessageSchema>;

export function parseWebSocketMessage(raw: unknown): WebSocketMessage {
  let payload: unknown;
  if (typeof raw === 'string' || raw instanceof Buffer) {
    const rawStr = raw.toString();
    try {
      payload = JSON.parse(rawStr);
    } catch (err) {
      // CRIT-6: um frame malformado (não-JSON) do cliente não deve derrubar a
      // conexão com um SyntaxError cru — o chamador (WebSocketManager.handleMessage)
      // já captura exceções e responde com uma mensagem 'error'; aqui logamos o
      // payload bruto para depuração e propagamos um erro claro.
      logger.warn('WebSocket message inválida — JSON malformado', {
        error: err instanceof Error ? err : undefined,
        context: { rawPreview: rawStr.slice(0, 200) },
      });
      throw new Error('Malformed WebSocket message: invalid JSON', {
        cause: err instanceof Error ? err : undefined,
      });
    }
  } else {
    payload = raw;
  }
  return websocketMessageSchema.parse(payload);
}

export function createWebSocketMessage(
  type: WebSocketMessage['type'],
  demandId: number,
  data: Record<string, unknown> = {},
): WebSocketMessage {
  return {
    type,
    demandId,
    timestamp: new Date().toISOString(),
    data,
  };
}
