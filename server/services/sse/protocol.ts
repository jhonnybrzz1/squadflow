/**
 * SSE Protocol - Contrato de Eventos para Server-Sent Events
 * Define a estrutura e sequência mínima de eventos para streaming SSE
 *
 * Contrato:
 * - status: started → (opcional) status: processing → status: completed|error
 * - Cada evento deve ter timestamp e correlação
 * - Erros devem ter código, mensagem e flag de retriable
 */

export type SSEEventType =
  | 'started'
  | 'processing'
  | 'completed'
  | 'error'
  | 'progress'
  | 'agent_chunk'
  | 'agent_reasoning_chunk'
  | 'agent_stream_end'
  | 'input_required'
  | 'roundtable_round_start'
  | 'roundtable_agent_start'
  | 'roundtable_agent_token'
  | 'roundtable_agent_message'
  | 'roundtable_agent_done'
  | 'roundtable_divergence'
  | 'roundtable_complete'
  | 'agent_failed';

export interface SSEEvent {
  type: SSEEventType;
  timestamp: number;
  demandId: number;
  operationId?: string;
  agent_id?: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    retriable: boolean;
  };
}

export interface SSEConnection {
  id: string;
  demandId: number;
  res: {
    // Subconjunto do Express Response usado pelo SSE
    write: (chunk: string) => boolean;
    end: () => void;
    flush?: () => void;
  };
  startTime: number;
  firstEventTime: number | null;
  eventCount: number;
  lastEventTime: number | null;
  isActive: boolean;
}

export interface SSEMessage {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

/**
 * Valida sequência mínima de eventos SSE
 * Regras:
 * - 'started' deve ser o primeiro evento
 * - 'processing' deve vir antes de trabalho pesado
 * - 'completed' ou 'error' deve ser o último evento
 */
export class SSEProtocolValidator {
  static validateSequence(events: SSEEvent[]): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (events.length === 0) {
      return { valid: false, errors: ['No events found'] };
    }

    // Regra 1: Primeiro evento deve ser 'started'
    if (events[0].type !== 'started') {
      errors.push(`First event must be 'started', got '${events[0].type}'`);
    }

    // Regra 2: Deve ter 'completed' ou 'error' como último evento
    const lastEvent = events[events.length - 1];
    if (lastEvent.type !== 'completed' && lastEvent.type !== 'error') {
      errors.push(`Last event must be 'completed' or 'error', got '${lastEvent.type}'`);
    }

    // Regra 3: 'processing' deve vir antes de 'completed' ou 'error'
    const hasProcessing = events.some((e) => e.type === 'processing');
    const hasTerminal = events.some((e) => e.type === 'completed' || e.type === 'error');

    if (hasTerminal && !hasProcessing) {
      // 'processing' é opcional, mas recomendado para trabalho pesado
      // Não é erro, mas pode ser warning
    }

    // Regra 4: 'error' não pode ser seguido por outros eventos (exceto se retriable)
    for (let i = 0; i < events.length - 1; i++) {
      if (events[i].type === 'error') {
        if (!events[i].error?.retriable) {
          errors.push(`Non-retriable error at index ${i} must be last event`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Cria evento no formato correto
   */
  static createEvent(
    type: SSEEventType,
    demandId: number,
    data?: Record<string, unknown>,
    error?: { code: string; message: string; retriable: boolean },
    operationId?: string,
    agent_id?: string,
    metadata?: Record<string, unknown>,
  ): SSEEvent {
    return {
      type,
      timestamp: Date.now(),
      demandId,
      operationId,
      agent_id,
      metadata,
      data,
      error,
    };
  }

  /**
   * Serializa evento para formato SSE
   */
  static serialize(event: SSEEvent): string {
    const message: SSEMessage = {
      data: JSON.stringify(event),
    };

    // Adicionar tipo como nome do evento se não for 'message' padrão
    // 'progress' uses the default 'message' event for backward compatibility
    if (event.type !== 'progress') {
      message.event = event.type;
    }

    // Formatar como SSE
    let sseMessage = '';
    if (message.event) {
      sseMessage += `event: ${message.event}\n`;
    }
    if (message.id) {
      sseMessage += `id: ${message.id}\n`;
    }
    if (message.retry) {
      sseMessage += `retry: ${message.retry}\n`;
    }
    sseMessage += `data: ${message.data}\n\n`;

    return sseMessage;
  }

  /**
   * Extrai eventos brutos para validação
   */
  static parseRawEvent(rawData: string): SSEEvent | null {
    try {
      const data = rawData.replace(/^data: /, '').trim();
      return JSON.parse(data) as SSEEvent;
    } catch (_) {
      return null;
    }
  }
}

/**
 * Constantes para configuração SSE
 */
export const SSE_CONFIG = {
  DEFAULT_RETRY_INTERVAL: 3000, // 3 segundos
  MAX_RETRY_ATTEMPTS: 3,
  CONNECTION_TIMEOUT: 300000, // 5 minutos
  HEARTBEAT_INTERVAL: 15000, // 15 segundos
} as const;
