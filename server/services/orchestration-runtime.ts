import { randomUUID } from 'crypto';
import { and, eq, lt } from 'drizzle-orm';
import { db as defaultDb, type DbClient } from '../db';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import {
  orchestrationRuns,
  agentTurns,
  agentToolCalls,
  orchestrationEvents,
} from '@shared/schema-unified';
import type {
  OrchestrationRunStatus,
  AgentTurnStatus,
  OrchestrationEventType,
} from '@shared/schema';

/**
 * Trilha de auditoria persistente da orquestração multiagente.
 *
 * Garantias de robustez (mitigações obrigatórias da spec):
 * - Todas as escritas são ASSÍNCRONAS, com retry e backoff exponencial.
 * - NENHUM método lança exceção que quebre o fluxo chamador (fail-open).
 *   Falhas de persistência apenas logam um warning — o SSE/chat segue intacto.
 *
 * F2 (backlog, não implementado aqui): endpoints GET de consulta, cobertura
 * total de tool calls e instrumentação real de tokens/custo.
 */

export interface StartRunInput {
  demandId: number;
  pipelineId?: string;
  mode?: string;
  agentOrder?: string[];
  regulatoryContext?: string | null;
  sensitivityLevel?: string | null;
  normaReferencia?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RunCompletionMetrics {
  tokensIn?: number | null;
  tokensOut?: number | null;
  costEstimated?: number | null;
  metadata?: Record<string, unknown>;
}

export interface StartAgentTurnInput {
  runId: string;
  demandId: number;
  agentName: string;
  turnIndex: number;
  metadata?: Record<string, unknown>;
}

export interface AgentTurnCompletion {
  durationMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costEstimated?: number | null;
  metadata?: Record<string, unknown>;
}

export interface RecordToolCallInput {
  turnId: string;
  runId: string;
  toolName: string;
  status: AgentTurnStatus;
  argsJson?: Record<string, unknown>;
  resultJson?: Record<string, unknown>;
  errorMessage?: string | null;
  durationMs?: number | null;
}

export interface RecordEventInput {
  runId: string;
  demandId: number;
  eventType: OrchestrationEventType;
  agentName?: string | null;
  payload?: Record<string, unknown>;
}

export interface RetryConfig {
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export class OrchestrationRuntimeService {
  // Promises das escritas em voo. Permite que testes (e shutdown gracioso)
  // aguardem o flush sem expor o I/O assíncrono ao caminho quente.
  private readonly inFlight = new Set<Promise<void>>();
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly database: DbClient = defaultDb,
    retryConfig?: RetryConfig,
  ) {
    this.maxRetries = retryConfig?.maxRetries ?? env.orchestrationMaxRetries;
    this.baseBackoffMs = retryConfig?.baseBackoffMs ?? env.orchestrationBaseBackoffMs;
    this.maxBackoffMs = retryConfig?.maxBackoffMs ?? env.orchestrationMaxBackoffMs;
  }

  /** Aguarda todas as escritas assíncronas pendentes (uso em testes/shutdown). */
  async flush(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  /**
   * Spec 015 B3 (H-11/FR-007): reconcilia registros `running` órfãos de um
   * crash/restart — nenhum run/turn permanece `running` para sempre (SC-003).
   * Usa threshold de 5 minutos para não matar runs/turns genuinamente
   * recém-criados durante o próprio startup.
   */
  async reconcileStaleRuns(): Promise<{ runs: number; turns: number }> {
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const writer = this.database as DrizzleWriter;
    let runs = 0;
    let turns = 0;
    try {
      const staleRuns = await writer
        .update(orchestrationRuns)
        .set({
          status: 'failed' satisfies OrchestrationRunStatus,
          errorMessage: 'interrupted_by_restart',
          completedAt: now,
        })
        .where(
          and(
            eq(orchestrationRuns.status, 'running'),
            lt(orchestrationRuns.startedAt, fiveMinutesAgo),
          ),
        );
      runs = (staleRuns as { changes?: number })?.changes ?? 0;

      const staleTurns = await writer
        .update(agentTurns)
        .set({
          status: 'failed' satisfies AgentTurnStatus,
          errorMessage: 'interrupted_by_restart',
          completedAt: now,
        })
        .where(and(eq(agentTurns.status, 'running'), lt(agentTurns.startedAt, fiveMinutesAgo)));
      turns = (staleTurns as { changes?: number })?.changes ?? 0;

      if (runs > 0 || turns > 0) {
        logger.warn('Trilha de orquestração reconciliada no startup', {
          context: { staleRuns: runs, staleTurns: turns },
        });
      }
    } catch (error) {
      logger.error('Falha ao reconciliar trilha de orquestração no startup', {
        error: error instanceof Error ? error : undefined,
      });
    }
    return { runs, turns };
  }

  // ---------------------------------------------------------------------------
  // Run lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Cria um run. Retorna o runId SEMPRE (mesmo se a persistência falhar), para
   * que o chamador possa correlacionar turnos/eventos sem bloquear no I/O.
   */
  startRun(input: StartRunInput): string {
    const runId = randomUUID();
    const now = new Date();

    this.fireAndForget(
      'startRun',
      () =>
        this.insert(orchestrationRuns, {
          runId,
          demandId: input.demandId,
          pipelineId: input.pipelineId ?? null,
          mode: input.mode ?? 'roundtable',
          status: 'running' satisfies OrchestrationRunStatus,
          agentOrder: input.agentOrder ?? null,
          regulatoryContext: input.regulatoryContext ?? null,
          sensitivityLevel: input.sensitivityLevel ?? null,
          normaReferencia: input.normaReferencia ?? null,
          metadata: input.metadata ?? null,
          startedAt: now,
        }),
      `run:${runId}`,
    );

    return runId;
  }

  completeRun(runId: string, metrics?: RunCompletionMetrics): void {
    this.finishRun(runId, 'completed', null, metrics);
  }

  failRun(runId: string, errorMessage: string, metrics?: RunCompletionMetrics): void {
    this.finishRun(runId, 'failed', errorMessage, metrics);
  }

  stopRun(runId: string, metrics?: RunCompletionMetrics): void {
    this.finishRun(runId, 'stopped', null, metrics);
  }

  private finishRun(
    runId: string,
    status: OrchestrationRunStatus,
    errorMessage: string | null,
    metrics?: RunCompletionMetrics,
  ): void {
    const now = new Date();
    this.fireAndForget(
      `finishRun:${status}`,
      () =>
        this.run(() =>
          (this.database as DrizzleWriter)
            .update(orchestrationRuns)
            .set({
              status,
              errorMessage,
              completedAt: now,
              tokensIn: metrics?.tokensIn ?? null,
              tokensOut: metrics?.tokensOut ?? null,
              costEstimated: metrics?.costEstimated ?? null,
              ...(metrics?.metadata ? { metadata: metrics.metadata } : {}),
            })
            .where(eq(orchestrationRuns.runId, runId)),
        ),
      `run:${runId}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Agent turns
  // ---------------------------------------------------------------------------

  /** Cria um turno de agente e retorna o turnId imediatamente. */
  startAgentTurn(input: StartAgentTurnInput): string {
    const turnId = randomUUID();
    const now = new Date();

    this.fireAndForget(
      'startAgentTurn',
      () =>
        this.insert(agentTurns, {
          turnId,
          runId: input.runId,
          demandId: input.demandId,
          agentName: input.agentName,
          turnIndex: input.turnIndex,
          status: 'running' satisfies AgentTurnStatus,
          metadata: input.metadata ?? null,
          startedAt: now,
        }),
      // Auditoria 2026-08-01 (A19): a chave era `turn:${turnId}`, uma cadeia
      // separada da do run — então o INSERT do turno podia chegar ao banco
      // antes do INSERT do run do qual ele depende por FK. Todas as escritas
      // de um mesmo run passam a compartilhar UMA cadeia, o que garante
      // pai-antes-de-filho por ordem de programa. Runs distintos seguem
      // paralelos entre si.
      `run:${input.runId}`,
    );

    this.turnRunIds.set(turnId, input.runId);

    return turnId;
  }

  completeAgentTurn(turnId: string, completion?: AgentTurnCompletion): void {
    this.finishAgentTurn(turnId, 'completed', null, completion);
  }

  failAgentTurn(turnId: string, errorMessage: string, completion?: AgentTurnCompletion): void {
    this.finishAgentTurn(turnId, 'failed', errorMessage, completion);
  }

  private finishAgentTurn(
    turnId: string,
    status: AgentTurnStatus,
    errorMessage: string | null,
    completion?: AgentTurnCompletion,
  ): void {
    const now = new Date();
    this.fireAndForget(
      `finishAgentTurn:${status}`,
      () =>
        this.run(() =>
          (this.database as DrizzleWriter)
            .update(agentTurns)
            .set({
              status,
              errorMessage,
              durationMs: completion?.durationMs ?? null,
              tokensIn: completion?.tokensIn ?? null,
              tokensOut: completion?.tokensOut ?? null,
              costEstimated: completion?.costEstimated ?? null,
              completedAt: now,
              ...(completion?.metadata ? { metadata: completion.metadata } : {}),
            })
            .where(eq(agentTurns.turnId, turnId)),
        ),
      // A19: mesma cadeia do run (ver startAgentTurn). Sem o runId conhecido,
      // cai na cadeia do turno — pior que nada não fica.
      this.orderKeyForTurn(turnId),
    );

    this.turnRunIds.delete(turnId);
  }

  /** A19: resolve a cadeia de escrita de um turno a partir do run dono. */
  private orderKeyForTurn(turnId: string): string {
    const runId = this.turnRunIds.get(turnId);
    return runId ? `run:${runId}` : `turn:${turnId}`;
  }

  // ---------------------------------------------------------------------------
  // Tool calls & events
  // ---------------------------------------------------------------------------

  recordToolCall(input: RecordToolCallInput): string {
    const toolCallId = randomUUID();
    this.fireAndForget(
      'recordToolCall',
      () =>
        this.insert(agentToolCalls, {
          toolCallId,
          turnId: input.turnId,
          runId: input.runId,
          toolName: input.toolName,
          status: input.status,
          argsJson: input.argsJson ?? null,
          resultJson: input.resultJson ?? null,
          errorMessage: input.errorMessage ?? null,
          durationMs: input.durationMs ?? null,
          createdAt: new Date(),
        }),
      // A19: sem cadeia, a tool call podia preceder o INSERT do turno ao qual
      // referencia por FK e ser perdida silenciosamente.
      `run:${input.runId}`,
    );
    return toolCallId;
  }

  recordEvent(input: RecordEventInput): string {
    const eventId = randomUUID();
    this.fireAndForget(
      'recordEvent',
      () =>
        this.insert(orchestrationEvents, {
          eventId,
          runId: input.runId,
          demandId: input.demandId,
          eventType: input.eventType,
          agentName: input.agentName ?? null,
          payload: input.payload ?? null,
          createdAt: new Date(),
        }),
      // A19: o caso original do achado — `startRun` retorna o runId antes do
      // INSERT do run, e o primeiro evento era publicado em seguida numa
      // cadeia distinta. Em PostgreSQL com latência, o filho chegava primeiro
      // e violava a FK.
      `run:${input.runId}`,
    );
    return eventId;
  }

  // ---------------------------------------------------------------------------
  // Infra: retry + backoff + fail-open
  // ---------------------------------------------------------------------------

  /**
   * Executa uma escrita com retry/backoff exponencial. Nunca lança: qualquer
   * falha após esgotar as tentativas vira um warning. Mantém o fluxo chamador
   * vivo mesmo que o DB esteja indisponível (mitigação "perda de eventos").
   */
  // Spec 015 B3 (H-11): escritas do MESMO run são seriais (insert precede
  // update por construção); runs distintos continuam paralelos.
  private writeChains = new Map<string, Promise<void>>();

  /**
   * A19: turnId -> runId dono, para que o UPDATE de fim de turno entre na
   * mesma cadeia do INSERT. Removido em `finishAgentTurn`, então o mapa vive
   * o tempo do turno, não do processo.
   */
  private turnRunIds = new Map<string, string>();

  private fireAndForget(op: string, write: () => Promise<unknown>, orderKey?: string): void {
    const start = orderKey
      ? (this.writeChains.get(orderKey) ?? Promise.resolve())
      : Promise.resolve();
    const p = start
      .then(() => this.withRetry(op, write))
      .catch(() => {
        // withRetry já loga; este catch existe apenas para satisfazer o void.
      })
      .finally(() => {
        this.inFlight.delete(p);
        if (orderKey && this.writeChains.get(orderKey) === p) {
          this.writeChains.delete(orderKey);
        }
      });
    if (orderKey) {
      this.writeChains.set(orderKey, p);
    }
    this.inFlight.add(p);
  }

  private calculateDelay(attempt: number): number {
    const delay = Math.min(this.baseBackoffMs * 2 ** attempt, this.maxBackoffMs);
    logger.warn('A-2: backoff aplicado', {
      context: {
        worker_name: 'OrchestrationRuntime',
        attempt,
        delay_applied: delay,
        base_backoff_ms: this.baseBackoffMs,
        max_backoff_ms: this.maxBackoffMs,
        timestamp: new Date().toISOString(),
      },
    });
    return delay;
  }

  private async withRetry(op: string, write: () => Promise<unknown>): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await write();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries) {
          const delay = this.calculateDelay(attempt);
          await this.sleep(delay);
        }
      }
    }
    logger.warn(`[OrchestrationRuntime] escrita '${op}' falhou após retries (fail-open)`, {
      error: lastError instanceof Error ? lastError : undefined,
      context: { op, attempts: this.maxRetries + 1 },
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async insert(table: DrizzleTable, values: Record<string, unknown>): Promise<unknown> {
    return this.run(() => (this.database as DrizzleWriter).insert(table).values(values));
  }

  private async run(thunk: () => DrizzleExecutable): Promise<unknown> {
    return await thunk();
  }
}

// Drizzle não expõe um tipo de writer comum entre os dois adaptadores; estes
// aliases mínimos evitam `any` na superfície pública mantendo a chamada tipada.
type DrizzleExecutable = Promise<unknown> | { then: PromiseLike<unknown>['then'] };
interface DrizzleTable {
  readonly _: unknown;
}
interface DrizzleWriter {
  insert(table: DrizzleTable): { values(v: Record<string, unknown>): DrizzleExecutable };
  update(table: DrizzleTable): {
    set(v: Record<string, unknown>): { where(cond: unknown): DrizzleExecutable };
  };
}

export const orchestrationRuntimeService = new OrchestrationRuntimeService();
