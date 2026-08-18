import { sql } from 'drizzle-orm';
import { dbHelper } from '../db';
import { logger } from '../utils/logger';

export type RefinementEventName =
  | 'refinement_started'
  | 'refinement_completed'
  | 'personality_baseline'
  | 'personality_applied'
  | 'pm_innovation_triggered'
  | 'pm_innovation_suggestion_feedback'
  | 'tone_feedback';

export interface RefinementEventInput {
  demandId: number;
  eventName: RefinementEventName;
  agentName?: string | null;
  agentMessageId?: string | null;
  personalityApplied?: boolean | null;
  suggestionAccepted?: boolean | null;
  toneFeedback?: 'like' | 'dislike' | null;
  metadata?: Record<string, unknown> | null;
}

export interface RefinementEventEntry extends RefinementEventInput {
  id: number;
  createdAt: Date;
}

class RefinementEventService {
  private tableReady = false;

  async ensureTable(): Promise<void> {
    if (this.tableReady) return;

    try {
      await dbHelper.run(sql`
        CREATE TABLE IF NOT EXISTS refinement_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          demand_id INTEGER NOT NULL,
          event_name TEXT NOT NULL,
          agent_name TEXT,
          agent_message_id TEXT,
          personality_applied INTEGER,
          suggestion_accepted INTEGER,
          tone_feedback TEXT CHECK (tone_feedback IN ('like', 'dislike', NULL)),
          metadata TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
      await dbHelper.run(sql`
        CREATE INDEX IF NOT EXISTS idx_refinement_events_demand_id ON refinement_events(demand_id)
      `);
      await dbHelper.run(sql`
        CREATE INDEX IF NOT EXISTS idx_refinement_events_event_name ON refinement_events(event_name)
      `);
      this.tableReady = true;
    } catch (error) {
      logger.warn('Could not create refinement_events table', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  async record(input: RefinementEventInput): Promise<RefinementEventEntry | null> {
    await this.ensureTable();
    if (!this.tableReady) return null;

    const now = Math.floor(Date.now() / 1000);
    const metadata = input.metadata ? JSON.stringify(input.metadata) : null;
    const personalityApplied =
      input.personalityApplied === null || input.personalityApplied === undefined
        ? null
        : input.personalityApplied
          ? 1
          : 0;
    const suggestionAccepted =
      input.suggestionAccepted === null || input.suggestionAccepted === undefined
        ? null
        : input.suggestionAccepted
          ? 1
          : 0;

    try {
      const rows = await dbHelper.all<{
        id: number;
        created_at: number;
      }>(sql`
        INSERT INTO refinement_events (
          demand_id,
          event_name,
          agent_name,
          agent_message_id,
          personality_applied,
          suggestion_accepted,
          tone_feedback,
          metadata,
          created_at
        )
        VALUES (
          ${input.demandId},
          ${input.eventName},
          ${input.agentName ?? null},
          ${input.agentMessageId ?? null},
          ${personalityApplied},
          ${suggestionAccepted},
          ${input.toneFeedback ?? null},
          ${metadata},
          ${now}
        )
        RETURNING id, created_at
      `);

      const row = rows[0];
      return {
        ...input,
        id: row?.id ?? 0,
        createdAt: new Date((row?.created_at ?? now) * 1000),
      };
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('syntax')) {
        throw error;
      }

      await dbHelper.run(sql`
        INSERT INTO refinement_events (
          demand_id,
          event_name,
          agent_name,
          agent_message_id,
          personality_applied,
          suggestion_accepted,
          tone_feedback,
          metadata,
          created_at
        )
        VALUES (
          ${input.demandId},
          ${input.eventName},
          ${input.agentName ?? null},
          ${input.agentMessageId ?? null},
          ${personalityApplied},
          ${suggestionAccepted},
          ${input.toneFeedback ?? null},
          ${metadata},
          ${now}
        )
      `);
      const rows = await dbHelper.all<{ id: number }>(sql`SELECT last_insert_rowid() AS id`);
      return {
        ...input,
        id: rows[0]?.id ?? 0,
        createdAt: new Date(now * 1000),
      };
    }
  }
}

export const refinementEventService = new RefinementEventService();
