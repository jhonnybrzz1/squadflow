/**
 * HumanFeedbackService — MVP
 *
 * Stores human feedback on agent messages in-memory with
 * optional SQLite persistence via dbHelper.
 */

import { dbHelper } from '../db';
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger';

export interface FeedbackEntry {
  id: number;
  demandId: number;
  agentMessageId: string;
  feedbackText: string;
  feedbackType: 'like' | 'dislike';
  agent: string | null;
  createdAt: Date;
}

class HumanFeedbackService {
  private store: Map<number, FeedbackEntry> = new Map();
  private nextId = 1;
  private tableReady = false;

  async ensureTable(): Promise<void> {
    if (this.tableReady) return;
    try {
      await dbHelper.run(sql`
        CREATE TABLE IF NOT EXISTS human_feedback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          demand_id INTEGER NOT NULL,
          agent_message_id TEXT NOT NULL,
          feedback_text TEXT NOT NULL DEFAULT '',
          feedback_type TEXT NOT NULL CHECK (feedback_type IN ('like', 'dislike')),
          agent TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
      await dbHelper.run(sql`
        CREATE INDEX IF NOT EXISTS idx_human_feedback_demand_id ON human_feedback(demand_id)
      `);
      await dbHelper.run(sql`
        CREATE INDEX IF NOT EXISTS idx_human_feedback_agent_message_id ON human_feedback(agent_message_id)
      `);
      this.tableReady = true;
    } catch (error) {
      logger.warn('Could not create human_feedback table, using in-memory only', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  async create(input: {
    demandId: number;
    agentMessageId: string;
    feedbackText: string;
    feedbackType: 'like' | 'dislike';
    agent?: string | null;
  }): Promise<FeedbackEntry> {
    const entry: FeedbackEntry = {
      id: this.nextId++,
      demandId: input.demandId,
      agentMessageId: input.agentMessageId,
      feedbackText: input.feedbackText,
      feedbackType: input.feedbackType,
      agent: input.agent ?? null,
      createdAt: new Date(),
    };

    this.store.set(entry.id, entry);

    // Fire-and-forget persist to SQLite
    this.persistToDb(entry).catch((err) => {
      logger.warn('Failed to persist feedback to SQLite', {
        error: err instanceof Error ? err : undefined,
      });
    });

    return entry;
  }

  getByDemandId(demandId: number): FeedbackEntry[] {
    return Array.from(this.store.values())
      .filter((f) => f.demandId === demandId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  getByMessageId(agentMessageId: string): FeedbackEntry[] {
    return Array.from(this.store.values())
      .filter((f) => f.agentMessageId === agentMessageId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /** Returns a set of agentMessageIds that have feedback for a given demand */
  getMessageIdsWithFeedback(demandId: number): Set<string> {
    const ids = new Set<string>();
    for (const entry of this.store.values()) {
      if (entry.demandId === demandId) {
        ids.add(entry.agentMessageId);
      }
    }
    return ids;
  }

  private async persistToDb(entry: FeedbackEntry): Promise<void> {
    await this.ensureTable();
    if (!this.tableReady) return;

    const ts = Math.floor(entry.createdAt.getTime() / 1000);
    await dbHelper.run(sql`
      INSERT INTO human_feedback (demand_id, agent_message_id, feedback_text, feedback_type, agent, created_at)
      VALUES (${entry.demandId}, ${entry.agentMessageId}, ${entry.feedbackText}, ${entry.feedbackType}, ${entry.agent}, ${ts})
    `);
  }
}

export const humanFeedbackService = new HumanFeedbackService();
