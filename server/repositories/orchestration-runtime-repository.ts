import { and, asc, desc, eq } from 'drizzle-orm';
import { db as defaultDb, type DbClient } from '../db';
import {
  agentToolCalls,
  agentTurns,
  orchestrationEvents,
  orchestrationRuns,
} from '@shared/schema-unified';
import type { OrchestrationEventType } from '@shared/schema';

export interface ListEventsOptions {
  eventType?: string;
  agentName?: string;
  limit?: number;
}

export interface OrchestrationRunDetails {
  run: unknown;
  turns: unknown[];
  toolCalls: unknown[];
  events: unknown[];
  summary: {
    turnCount: number;
    toolCallCount: number;
    eventCount: number;
    failedTurns: number;
    failedToolCalls: number;
  };
}

const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 1000;

export class OrchestrationRuntimeRepository {
  constructor(private readonly database: DbClient = defaultDb) {}

  async listRunsByDemand(demandId: number) {
    return await this.selectFrom(orchestrationRuns)
      .where(eq(orchestrationRuns.demandId, demandId))
      .orderBy(desc(orchestrationRuns.startedAt));
  }

  async getRun(runId: string) {
    const rows = await this.selectFrom(orchestrationRuns)
      .where(eq(orchestrationRuns.runId, runId))
      .limit(1);
    return rows[0] ?? null;
  }

  async listTurns(runId: string) {
    return await this.selectFrom(agentTurns)
      .where(eq(agentTurns.runId, runId))
      .orderBy(asc(agentTurns.turnIndex), asc(agentTurns.startedAt));
  }

  async listToolCallsByRun(runId: string) {
    return await this.selectFrom(agentToolCalls)
      .where(eq(agentToolCalls.runId, runId))
      .orderBy(asc(agentToolCalls.createdAt));
  }

  async listToolCallsByTurn(turnId: string) {
    return await this.selectFrom(agentToolCalls)
      .where(eq(agentToolCalls.turnId, turnId))
      .orderBy(asc(agentToolCalls.createdAt));
  }

  async listEvents(runId: string, options: ListEventsOptions = {}) {
    const filters = [eq(orchestrationEvents.runId, runId)];
    if (options.eventType) {
      filters.push(eq(orchestrationEvents.eventType, options.eventType as OrchestrationEventType));
    }
    if (options.agentName) {
      filters.push(eq(orchestrationEvents.agentName, options.agentName));
    }

    const limit = clampLimit(options.limit);
    return await this.selectFrom(orchestrationEvents)
      .where(and(...filters))
      .orderBy(asc(orchestrationEvents.createdAt))
      .limit(limit);
  }

  async getRunDetails(runId: string): Promise<OrchestrationRunDetails | null> {
    const run = await this.getRun(runId);
    if (!run) return null;

    const [turns, toolCalls, events] = await Promise.all([
      this.listTurns(runId),
      this.listToolCallsByRun(runId),
      this.listEvents(runId, { limit: MAX_EVENT_LIMIT }),
    ]);

    return {
      run,
      turns,
      toolCalls,
      events,
      summary: {
        turnCount: turns.length,
        toolCallCount: toolCalls.length,
        eventCount: events.length,
        failedTurns: turns.filter((turn: { status?: string }) => turn.status === 'failed').length,
        failedToolCalls: toolCalls.filter(
          (toolCall: { status?: string }) => toolCall.status === 'failed',
        ).length,
      },
    };
  }

  private selectFrom(table: DrizzleTable): SelectQuery {
    return (this.database as unknown as DrizzleReader).select().from(table);
  }
}

function clampLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_EVENT_LIMIT;
  return Math.min(Math.max(Number(limit), 1), MAX_EVENT_LIMIT);
}

export const orchestrationRuntimeRepository = new OrchestrationRuntimeRepository();

interface DrizzleTable {
  readonly _: unknown;
}

interface DrizzleReader {
  select(): { from(table: DrizzleTable): SelectQuery };
}

interface SelectQuery extends PromiseLike<Array<Record<string, unknown>>> {
  where(condition: unknown): SelectQuery;
  orderBy(...columns: unknown[]): SelectQuery;
  limit(limit: number): SelectQuery;
}
