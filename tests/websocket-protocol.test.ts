import { describe, expect, it } from 'vitest';
import {
  createWebSocketMessage,
  parseWebSocketMessage,
} from '../server/services/websocket/protocol';

describe('interactive websocket protocol', () => {
  it('parses valid answer messages', () => {
    const parsed = parseWebSocketMessage(
      JSON.stringify({
        type: 'answer',
        data: { interactionId: 'q1', sequence: 1, answer: 'Sim' },
      }),
    );

    expect(parsed.type).toBe('answer');
    expect(parsed.data.answer).toBe('Sim');
  });

  it('creates timestamped outbound messages', () => {
    const message = createWebSocketMessage('status', 42, { status: 'ACTIVE' });
    expect(message.demandId).toBe(42);
    expect(message.timestamp).toBeTruthy();
  });

  it('CRIT-6: rejeita JSON malformado com erro claro em vez de SyntaxError cru', () => {
    expect(() => parseWebSocketMessage('{not valid json')).toThrow(
      'Malformed WebSocket message: invalid JSON',
    );
  });
});
