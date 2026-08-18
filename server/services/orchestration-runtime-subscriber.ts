import {
  eventBus,
  type OrchestrationEvent,
  type AgentLifecycleEvent,
  type ToolCallLifecycleEvent,
  type RoundtableDivergenceEvent,
} from '../events/event-bus';
import {
  orchestrationRuntimeService,
  type OrchestrationRuntimeService,
} from './orchestration-runtime';
import { logger } from '../utils/logger';

/**
 * Liga os eventos de ciclo de vida da orquestração (publicados pelo
 * agent-orchestrator no eventBus) à trilha de auditoria persistente.
 *
 * Desacopla o caminho quente da orquestração da camada de persistência: o
 * orquestrador apenas publica eventos; este subscriber os materializa no DB de
 * forma assíncrona e fail-open (o service nunca lança).
 *
 * Idempotente: chamar registerOrchestrationRuntimeSubscriber() múltiplas vezes
 * registra os handlers apenas uma vez.
 */

let registered = false;

// Correlação turnIndex -> turnId por run, para fechar o turno no AGENT_COMPLETED/FAILED.
const turnIndexToId = new Map<string, string>();

function turnKey(runId: string, turnIndex: number): string {
  return `${runId}::${turnIndex}`;
}

export function getOrchestrationTurnId(runId: string, turnIndex: number): string | undefined {
  return turnIndexToId.get(turnKey(runId, turnIndex));
}

export function registerOrchestrationRuntimeSubscriber(
  service: OrchestrationRuntimeService = orchestrationRuntimeService,
): void {
  if (registered) return;
  registered = true;

  eventBus.subscribe<OrchestrationEvent>('ORCHESTRATION_STARTED', (e) => {
    if (!e.runId) return;
    service.recordEvent({
      runId: e.runId,
      demandId: e.demandId,
      eventType: 'ORCHESTRATION_STARTED',
      payload: { pipelineId: e.pipelineId, totalAgents: e.metadata?.totalAgents },
    });
  });

  eventBus.subscribe<OrchestrationEvent>('ORCHESTRATION_COMPLETED', (e) => {
    if (!e.runId) return;
    service.recordEvent({
      runId: e.runId,
      demandId: e.demandId,
      eventType: 'ORCHESTRATION_COMPLETED',
      payload: { durationMs: e.durationMs, ...(e.metadata ?? {}) },
    });
    service.completeRun(e.runId);
  });

  eventBus.subscribe<OrchestrationEvent>('ORCHESTRATION_FAILED', (e) => {
    if (!e.runId) return;
    service.recordEvent({
      runId: e.runId,
      demandId: e.demandId,
      eventType: 'ORCHESTRATION_FAILED',
      payload: { durationMs: e.durationMs, error: e.error },
    });
    service.failRun(e.runId, e.error ?? 'Unknown orchestration error');
  });

  eventBus.subscribe<AgentLifecycleEvent>('AGENT_STARTED', (e) => {
    if (!e.runId) return;
    const turnId = service.startAgentTurn({
      runId: e.runId,
      demandId: e.demandId,
      agentName: e.agentName,
      turnIndex: e.turnIndex,
    });
    turnIndexToId.set(turnKey(e.runId, e.turnIndex), turnId);
    service.recordEvent({
      runId: e.runId,
      demandId: e.demandId,
      eventType: 'AGENT_STARTED',
      agentName: e.agentName,
      payload: { turnIndex: e.turnIndex },
    });
  });

  eventBus.subscribe<AgentLifecycleEvent>('AGENT_COMPLETED', (e) => {
    if (!e.runId) return;
    const key = turnKey(e.runId, e.turnIndex);
    const turnId = turnIndexToId.get(key);
    if (turnId) {
      service.completeAgentTurn(turnId, { durationMs: e.durationMs });
      turnIndexToId.delete(key);
    }
    service.recordEvent({
      runId: e.runId,
      demandId: e.demandId,
      eventType: 'AGENT_COMPLETED',
      agentName: e.agentName,
      payload: { turnIndex: e.turnIndex, durationMs: e.durationMs },
    });
  });

  eventBus.subscribe<AgentLifecycleEvent>('AGENT_FAILED', (e) => {
    if (!e.runId) return;
    const key = turnKey(e.runId, e.turnIndex);
    const turnId = turnIndexToId.get(key);
    if (turnId) {
      service.failAgentTurn(turnId, e.error ?? 'Unknown agent error', { durationMs: e.durationMs });
      turnIndexToId.delete(key);
    }
    service.recordEvent({
      runId: e.runId,
      demandId: e.demandId,
      eventType: 'AGENT_FAILED',
      agentName: e.agentName,
      payload: { turnIndex: e.turnIndex, durationMs: e.durationMs, error: e.error },
    });
  });

  eventBus.subscribe<ToolCallLifecycleEvent>('TOOL_CALL_COMPLETED', (e) => {
    recordToolCallEvent(service, e, 'TOOL_CALL_COMPLETED');
  });

  eventBus.subscribe<ToolCallLifecycleEvent>('TOOL_CALL_FAILED', (e) => {
    recordToolCallEvent(service, e, 'TOOL_CALL_FAILED');
  });

  eventBus.subscribe<RoundtableDivergenceEvent>('ROUNDTABLE_DIVERGENCE_RECORDED', (e) => {
    if (!e.runId) return;
    service.recordEvent({
      runId: e.runId,
      demandId: e.demandId,
      eventType: 'ROUNDTABLE_DIVERGENCE_RECORDED',
      agentName: e.agentName,
      payload: {
        pipelineId: e.pipelineId,
        turnIndex: e.turnIndex,
        round: e.round,
        content: e.content,
        dialogueMove: e.dialogueMove,
      },
    });
  });

  logger.info('[OrchestrationRuntime] subscriber registrado no eventBus');
}

/**
 * Reset interno para testes: remove os handlers do eventBus e limpa o estado de
 * correlação, permitindo registrar um subscriber com um service injetado.
 * NÃO usar em produção.
 */
export function __resetOrchestrationRuntimeSubscriberForTests(): void {
  for (const evt of [
    'ORCHESTRATION_STARTED',
    'ORCHESTRATION_COMPLETED',
    'ORCHESTRATION_FAILED',
    'AGENT_STARTED',
    'AGENT_COMPLETED',
    'AGENT_FAILED',
    'TOOL_CALL_COMPLETED',
    'TOOL_CALL_FAILED',
    'ROUNDTABLE_DIVERGENCE_RECORDED',
  ] as const) {
    eventBus.removeAllListeners(evt);
  }
  turnIndexToId.clear();
  registered = false;
}

function recordToolCallEvent(
  service: OrchestrationRuntimeService,
  event: ToolCallLifecycleEvent,
  eventType: 'TOOL_CALL_COMPLETED' | 'TOOL_CALL_FAILED',
): void {
  if (!event.runId) return;
  const turnId =
    event.turnId ??
    (typeof event.turnIndex === 'number'
      ? getOrchestrationTurnId(event.runId, event.turnIndex)
      : undefined);
  if (!turnId) return;

  service.recordToolCall({
    runId: event.runId,
    turnId,
    toolName: event.toolName,
    status: event.status,
    argsJson: event.argsJson,
    resultJson: event.resultJson,
    errorMessage: event.errorMessage,
    durationMs: event.durationMs,
  });
  service.recordEvent({
    runId: event.runId,
    demandId: event.demandId,
    eventType,
    agentName: event.agentName ?? null,
    payload: {
      pipelineId: event.pipelineId,
      turnId,
      turnIndex: event.turnIndex,
      toolName: event.toolName,
      status: event.status,
      durationMs: event.durationMs,
      errorMessage: event.errorMessage,
    },
  });
}
