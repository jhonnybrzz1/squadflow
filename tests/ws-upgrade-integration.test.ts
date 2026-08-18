import { createServer, type Server } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

vi.mock('../server/repositories/demand-repository', () => ({
  demandRepository: {
    findByIdOrNull: vi.fn(async (id: number) => (id === 1 ? { id: 1, title: 'demanda' } : null)),
  },
}));

vi.mock('../server/services/refinement-interaction', () => ({
  refinementInteractionService: {
    getStatus: vi.fn(async () => ({ state: 'idle' })),
    pause: vi.fn(async () => ({ ok: true })),
    resume: vi.fn(async () => ({ ok: true })),
    applyResponse: vi.fn(async () => ({ ok: true })),
  },
  RefinementInteractionError: class RefinementInteractionError extends Error {},
}));

import { InteractiveWebSocketManager } from '../server/services/websocket/manager';
import { webSocketOriginPolicy } from '../server/services/websocket/origin-policy';

function connect(
  port: number,
  path: string,
  origin?: string,
): Promise<{ opened: boolean; statusCode?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: origin ? { origin } : {},
    });
    ws.on('open', () => {
      ws.close();
      resolve({ opened: true });
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve({ opened: false, statusCode: res.statusCode });
    });
    ws.on('error', () => resolve({ opened: false }));
  });
}

describe('WebSocket upgrade (spec 012 US1)', () => {
  let server: Server;
  let port: number;
  let manager: InteractiveWebSocketManager;

  beforeEach(async () => {
    server = createServer((_req, res) => res.end('ok'));
    manager = new InteractiveWebSocketManager();
    manager.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
    webSocketOriginPolicy.setActualPort(port);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('aceita origem local permitida com demanda existente', async () => {
    const result = await connect(port, '/api/demands/1/ws', `http://127.0.0.1:${port}`);
    expect(result.opened).toBe(true);
  });

  it('rejeita origem externa com 403 antes de qualquer payload', async () => {
    const result = await connect(port, '/api/demands/1/ws', 'https://evil.example');
    expect(result.opened).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it('rejeita origem ausente com 403', async () => {
    const result = await connect(port, '/api/demands/1/ws');
    expect(result.opened).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it('rejeita demanda inexistente com 403 uniforme (sem oráculo)', async () => {
    const result = await connect(port, '/api/demands/999999/ws', `http://127.0.0.1:${port}`);
    expect(result.opened).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it('paths de upgrade não casados permanecem pass-through (HMR)', async () => {
    // Um segundo listener (papel do HMR do Vite) deve receber o evento
    // intacto — o manager não pode ter respondido 403 nem destruído o socket.
    const seenByOtherListener: string[] = [];
    server.on('upgrade', (request, socket) => {
      if (request.url === '/vite-hmr') {
        seenByOtherListener.push(request.url);
        expect(socket.destroyed).toBe(false);
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
      }
    });

    const result = await connect(port, '/vite-hmr', 'https://evil.example');
    expect(result.opened).toBe(false);
    expect(result.statusCode).toBe(404);
    expect(seenByOtherListener).toEqual(['/vite-hmr']);
  });

  it('FR-002A: comando referenciando outra demanda é ignorado sem ack', async () => {
    const acks: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/demands/1/ws`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'ack') acks.push(message.data?.action);
    });

    ws.send(JSON.stringify({ type: 'pause', demandId: 2, data: {} }));
    ws.send(JSON.stringify({ type: 'pause', data: {} }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    ws.close();

    // Só o pause escopado à demanda da conexão gera ack.
    expect(acks).toEqual(['pause']);
  });
});
