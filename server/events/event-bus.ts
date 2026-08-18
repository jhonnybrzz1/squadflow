import { EventEmitter } from 'events';
import type { HandoffManifest } from '@shared/handoff-manifest';
import { logger } from '../utils/logger';
import { deadLetterService } from '../services/dead-letter-service';

// Tipos de Eventos do Domínio
export type DomainEvent =
  | 'DOCUMENT_GENERATION_REQUESTED'
  | 'DOCUMENT_GENERATED'
  | 'DEMAND_ANALYSIS_COMPLETED'
  | 'ORCHESTRATION_STARTED'
  | 'ORCHESTRATION_COMPLETED'
  | 'ORCHESTRATION_FAILED'
  | 'AGENT_STARTED'
  | 'AGENT_COMPLETED'
  | 'AGENT_FAILED'
  | 'TOOL_CALL_COMPLETED'
  | 'TOOL_CALL_FAILED'
  | 'ROUNDTABLE_DIVERGENCE_RECORDED'
  /** Spec 10044 — speckit escrito com sucesso; gatilho único do agente de código. */
  | 'SPECKIT_COMPLETED';

/**
 * Spec 10044 — payload de `SPECKIT_COMPLETED`. Emitido após `buildHandoffFiles`
 * gerar o handoff no diretório `specs/{demandId}-handoff/`. Carrega o manifest
 * (validado no handler antes do disparo) e o conteúdo do `spec.md`.
 */
export interface SpeckitCompletedPayload {
  demandId: number;
  /** Diretório do handoff, ex.: "specs/42-handoff". */
  specDir: string;
  /** Caminho do spec.md, ex.: "specs/42-handoff/spec.md". */
  specPath: string;
  /** Conteúdo do spec.md — vira o prompt do agente de código. */
  specContent: string;
  /** Manifest do handoff — contrato estruturado validado antes do disparo. */
  manifest: HandoffManifest;
}

export interface DocumentGenerationPayload {
  demandId: number;
  type: string;
  content: string;
  targetFilepath: string;
  /** Spec 015 B2 (H-10): job durável persistido antes do aceite HTTP. */
  jobId?: string;
}

/**
 * Represents an orchestration lifecycle event emitted during agent pipeline execution.
 * These events track the start, completion, and failure of orchestration workflows.
 */
export interface OrchestrationEvent {
  /** ISO 8601 formatted timestamp of when the event occurred */
  timestamp: string;
  /** Unique identifier for the pipeline execution (maps to requestId) */
  pipelineId: string;
  /** Run da trilha de auditoria persistente (quando há um run associado) */
  runId?: string;
  /** ID of the demand being processed */
  demandId: number;
  /** Current status of the orchestration */
  status: 'started' | 'completed' | 'failed';
  /** Duration of execution in milliseconds (not present for 'started' status) */
  durationMs?: number;
  /** Error message (only present when status is 'failed') */
  error?: string;
  /** Additional metadata about the orchestration execution */
  metadata?: {
    /** Total number of agents in the pipeline */
    totalAgents?: number;
    /** Number of agents that executed successfully */
    successCount?: number;
    /** Number of agents that failed */
    failedCount?: number;
    /** Execution duration per agent in milliseconds */
    agentDurations?: Record<string, number>;
  };
}

/**
 * Evento de ciclo de vida de um agente individual dentro de um run de
 * orquestração. Usado pela trilha de auditoria persistente.
 */
export interface AgentLifecycleEvent {
  timestamp: string;
  runId?: string;
  pipelineId: string;
  demandId: number;
  agentName: string;
  turnIndex: number;
  status: 'started' | 'completed' | 'failed';
  durationMs?: number;
  error?: string;
}

export interface ToolCallLifecycleEvent {
  timestamp: string;
  runId?: string;
  turnId?: string;
  turnIndex?: number;
  pipelineId?: string;
  demandId: number;
  agentName?: string;
  toolName: string;
  status: 'completed' | 'failed';
  argsJson?: Record<string, unknown>;
  resultJson?: Record<string, unknown>;
  errorMessage?: string | null;
  durationMs?: number | null;
}

export interface RoundtableDivergenceEvent {
  timestamp: string;
  runId?: string;
  pipelineId: string;
  demandId: number;
  agentName: string;
  turnIndex: number;
  round: number;
  content: string;
  dialogueMove?: string;
}

export interface EventEnvelope {
  eventId: string;
  eventType: DomainEvent;
  payload: unknown;
}

/**
 * A DLQ é o último recurso do bus: falhar ao gravar nela não pode derrubar o
 * processo. `deadLetterService.insert` loga e re-lança, e os três pontos de
 * chamada aqui são fire-and-forget — sem este catch a rejeição escapa como
 * unhandled rejection (o Node moderno mata o processo nisso). Foi o que apareceu
 * assim que os testes deixaram de gravar no banco real e passaram a encontrar um
 * banco isolado sem a tabela `dead_letters`.
 */
function persistDeadLetter(event: EventEnvelope, error: unknown): void {
  void deadLetterService
    .insert({
      eventId: event.eventId,
      eventType: event.eventType,
      payload: event.payload,
      error,
    })
    .catch(() => {
      // Já logado com stack em DeadLetterService.insert.
    });
}

function safeExecute<T>(
  event: EventEnvelope,
  handler: (payload: T) => Promise<void> | void,
): Promise<void> | void {
  try {
    const result = handler(event.payload as T);
    if (result && typeof (result as Promise<void>).catch === 'function') {
      return (result as Promise<void>).catch((error) => {
        persistDeadLetter(event, error);
      });
    }
    return result;
  } catch (error) {
    persistDeadLetter(event, error);
  }
}

function generateEventId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

class SystemEventBus extends EventEmitter {
  private subscriberRegistry: Map<DomainEvent, Set<(...args: unknown[]) => unknown>> = new Map();

  constructor() {
    super();
    this.setMaxListeners(20);
  }

  /**
   * M-2: publica evento. Se nenhum listener estiver registrado, o evento vai para
   * a dead-letter queue para evitar perda silenciosa.
   */
  publish(event: DomainEvent, payload: unknown): void {
    const eventId = generateEventId();
    logger.debug(`[EventBus] Publishing event: ${event}`, { context: { eventId } });

    const registered = this.subscriberRegistry.get(event);
    if (!registered || registered.size === 0) {
      persistDeadLetter(
        { eventId, eventType: event, payload },
        new Error('M-2: event published with no registered subscriber'),
      );
      return;
    }

    this.emit(event, { eventId, eventType: event, payload });
  }

  /**
   * M-2: inscreve handler com safeExecute e registra em listener registry.
   */
  subscribe<T>(event: DomainEvent, handler: (payload: T) => Promise<void> | void): void {
    logger.info(`[EventBus] Subscribed to event: ${event}`);

    const wrapped = (envelope: EventEnvelope) => {
      safeExecute<T>(envelope, handler);
    };

    if (!this.subscriberRegistry.has(event)) {
      this.subscriberRegistry.set(event, new Set());
    }
    this.subscriberRegistry.get(event)!.add(wrapped as (...args: unknown[]) => unknown);

    this.on(event, (envelope: EventEnvelope) => wrapped(envelope));
  }

  /**
   * M-2: retorna eventos registrados para debug/teste.
   */
  getRegisteredEvents(): DomainEvent[] {
    return [...this.subscriberRegistry.keys()];
  }

  /**
   * M-2: limpa todos os listeners e registros (útil em testes).
   */
  reset(): void {
    this.removeAllListeners();
    this.subscriberRegistry.clear();
  }
}

export const eventBus = new SystemEventBus();
