export type InteractiveMessageType =
  | 'hello'
  | 'status'
  | 'question'
  | 'suggestion'
  | 'ack'
  | 'error';

export interface InteractiveMessage<T = Record<string, unknown>> {
  type: InteractiveMessageType;
  demandId?: number;
  timestamp?: string;
  data: T;
}

export class WebSocketService {
  private socket: WebSocket | null = null;
  private handlers = new Map<string, Set<(message: InteractiveMessage) => void>>();

  connect(demandId: number): void {
    this.disconnect();
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(`${protocol}//${window.location.host}/api/demands/${demandId}/ws`);
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as InteractiveMessage;
      this.emit(message.type, message);
    };
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = null;
  }

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  sendAnswer(interactionId: string, sequence: number, answer: string): boolean {
    return this.send({ type: 'answer', data: { interactionId, sequence, answer } });
  }

  sendPause(reason?: string): boolean {
    return this.send({ type: 'pause', data: { reason } });
  }

  sendResume(): boolean {
    return this.send({ type: 'resume', data: {} });
  }

  requestStatus(): boolean {
    return this.send({ type: 'status', data: {} });
  }

  on(type: InteractiveMessageType, handler: (message: InteractiveMessage) => void): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  private send(message: { type: string; data: Record<string, unknown> }): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private emit(type: string, message: InteractiveMessage): void {
    for (const handler of this.handlers.get(type) ?? []) {
      handler(message);
    }
  }
}
