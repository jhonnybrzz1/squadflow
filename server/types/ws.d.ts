declare module 'ws' {
  import type { IncomingMessage } from 'http';
  import type { Duplex } from 'stream';

  export class WebSocket {
    static readonly OPEN: number;
    readonly readyState: number;
    send(data: string): void;
    close(): void;
    on(event: 'message', listener: (data: unknown) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
  }

  export class WebSocketServer {
    constructor(options: { noServer: true });
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (ws: WebSocket) => void,
    ): void;
    emit(event: 'connection', ws: WebSocket, request: IncomingMessage, demandId: number): boolean;
    on(
      event: 'connection',
      listener: (ws: WebSocket, request: IncomingMessage, demandId: number) => void,
    ): this;
  }
}
