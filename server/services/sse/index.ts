/**
 * SSE Module - Exportações do módulo de Server-Sent Events
 */

export { SSEManager, sseManager } from './manager';
export {
  SSEProtocolValidator,
  type SSEConnection,
  type SSEEvent,
  type SSEEventType,
  type SSEMessage,
} from './protocol';
