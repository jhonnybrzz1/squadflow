/**
 * RAG Feedback Loop Service
 *
 * Records user feedback on retrieved chunks and uses it to boost/demote
 * chunks in future retrievals. Supports:
 *
 * - Implicit feedback (chunk was shown → shown count++)
 * - Explicit feedback (user rated helpful/not helpful)
 * - Click feedback (user selected a specific chunk)
 *
 * Boost formula:
 *   successRate > 0.7 → 1.2x boost
 *   successRate 0.5-0.7 → 1.0 (neutral)
 *   successRate < 0.5 → 0.8x penalty
 *
 * The boost factor is applied as a multiplier on the retrieval score.
 */

import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import { dbHelper, isPostgres } from '../db';
import { logger } from '../utils/logger';

type FeedbackType = 'implicit' | 'explicit' | 'click';
type ChunkSource = 'refinement';

interface RAGFeedback {
  queryId: string;
  queryText: string;
  chunkId: string;
  chunkSource: ChunkSource;
  wasHelpful: boolean;
  selectedByUser?: boolean;
  feedbackType?: FeedbackType;
  sessionId?: string;
}

interface ChunkRelevanceScore {
  chunkId: string;
  chunkSource: ChunkSource;
  totalShown: number;
  totalHelpful: number;
  totalSelected: number;
  successRate: number;
  boostFactor: number;
}

export class RAGFeedbackService {
  private initialized = false;
  private boostCache: Map<string, number> = new Map();
  private readonly CACHE_TTL_MS = 60_000; // 1 minute cache
  private lastCacheRefresh = 0;

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.ensureSchema();
    this.initialized = true;
  }

  /**
   * Record feedback for a retrieved chunk.
   */
  async recordFeedback(feedback: RAGFeedback): Promise<void> {
    await this.ensureInitialized();

    try {
      const id = randomUUID();
      const feedbackType = feedback.feedbackType || 'implicit';

      if (isPostgres) {
        await dbHelper.run(sql`
          INSERT INTO rag_feedback (id, query_id, query_text, chunk_id, chunk_source,
            was_helpful, selected_by_user, feedback_type, session_id)
          VALUES (${id}, ${feedback.queryId}, ${feedback.queryText}, ${feedback.chunkId},
            ${feedback.chunkSource}, ${feedback.wasHelpful}, ${feedback.selectedByUser || false},
            ${feedbackType}, ${feedback.sessionId || null})
        `);
      } else {
        await dbHelper.run(sql`
          INSERT INTO rag_feedback (id, query_id, query_text, chunk_id, chunk_source,
            was_helpful, selected_by_user, feedback_type, session_id, created_at)
          VALUES (${id}, ${feedback.queryId}, ${feedback.queryText}, ${feedback.chunkId},
            ${feedback.chunkSource}, ${feedback.wasHelpful ? 1 : 0},
            ${feedback.selectedByUser ? 1 : 0}, ${feedbackType},
            ${feedback.sessionId || null}, ${Date.now()})
        `);
      }

      // Update aggregated scores
      await this.updateChunkScores(feedback.chunkId, feedback.chunkSource);

      // Invalidate cache for this chunk
      this.boostCache.delete(`${feedback.chunkId}:${feedback.chunkSource}`);
    } catch (error) {
      logger.warn('Failed to record RAG feedback', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Record implicit feedback for all chunks shown in a retrieval.
   * Fire-and-forget — does not block the response.
   */
  recordImplicitFeedback(
    queryId: string,
    queryText: string,
    chunkIds: string[],
    chunkSource: ChunkSource,
  ): void {
    for (const chunkId of chunkIds) {
      this.recordFeedback({
        queryId,
        queryText,
        chunkId,
        chunkSource,
        wasHelpful: true, // Being shown = implicit positive signal
        feedbackType: 'implicit',
      }).catch(() => {
        // Fire-and-forget
      });
    }
  }

  /**
   * Get the boost factor for a chunk.
   * Returns 1.0 if no feedback exists (neutral).
   */
  async getChunkBoost(chunkId: string, chunkSource: ChunkSource): Promise<number> {
    await this.ensureInitialized();

    const cacheKey = `${chunkId}:${chunkSource}`;

    // Check cache
    if (Date.now() - this.lastCacheRefresh < this.CACHE_TTL_MS) {
      const cached = this.boostCache.get(cacheKey);
      if (cached !== undefined) return cached;
    }

    try {
      const rows = await dbHelper.all<{ boost_factor: number }>(sql`
        SELECT boost_factor FROM chunk_relevance_scores
        WHERE chunk_id = ${chunkId} AND chunk_source = ${chunkSource}
        LIMIT 1
      `);

      const boost = rows.length > 0 ? Number(rows[0].boost_factor) : 1.0;
      this.boostCache.set(cacheKey, boost);
      return boost;
    } catch (_) {
      return 1.0;
    }
  }

  /**
   * Get boost factors for multiple chunks at once (batch query).
   */
  async getChunkBoosts(chunkIds: string[], chunkSource: ChunkSource): Promise<Map<string, number>> {
    await this.ensureInitialized();
    const boosts = new Map<string, number>();

    if (chunkIds.length === 0) return boosts;

    try {
      // For simplicity, query all scores for this source
      const rows = await dbHelper.all<{
        chunk_id: string;
        boost_factor: number;
      }>(sql`
        SELECT chunk_id, boost_factor FROM chunk_relevance_scores
        WHERE chunk_source = ${chunkSource}
      `);

      for (const row of rows) {
        boosts.set(row.chunk_id, Number(row.boost_factor));
      }
    } catch (_) {
      // Return empty map on error
    }

    return boosts;
  }

  /**
   * Update aggregated chunk scores based on feedback history.
   */
  private async updateChunkScores(chunkId: string, chunkSource: ChunkSource): Promise<void> {
    try {
      // Count feedback for this chunk
      const stats = await dbHelper.all<{
        total_shown: number;
        total_helpful: number;
        total_selected: number;
      }>(sql`
        SELECT
          COUNT(*) as total_shown,
          SUM(CASE WHEN was_helpful = ${isPostgres ? sql`TRUE` : sql`1`} THEN 1 ELSE 0 END) as total_helpful,
          SUM(CASE WHEN selected_by_user = ${isPostgres ? sql`TRUE` : sql`1`} THEN 1 ELSE 0 END) as total_selected
        FROM rag_feedback
        WHERE chunk_id = ${chunkId} AND chunk_source = ${chunkSource}
      `);

      if (stats.length === 0) return;

      const totalShown = Number(stats[0].total_shown) || 0;
      const totalHelpful = Number(stats[0].total_helpful) || 0;
      const totalSelected = Number(stats[0].total_selected) || 0;
      const successRate = totalShown > 0 ? totalHelpful / totalShown : 0;

      // Compute boost factor
      let boostFactor: number;
      if (totalShown < 3) {
        boostFactor = 1.0; // Not enough data
      } else if (successRate > 0.7) {
        boostFactor = 1.2;
      } else if (successRate > 0.5) {
        boostFactor = 1.0;
      } else {
        boostFactor = 0.8;
      }

      // Upsert aggregated scores
      if (isPostgres) {
        await dbHelper.run(sql`
          INSERT INTO chunk_relevance_scores
            (chunk_id, chunk_source, total_shown, total_helpful, total_selected, success_rate, boost_factor, updated_at)
          VALUES
            (${chunkId}, ${chunkSource}, ${totalShown}, ${totalHelpful}, ${totalSelected}, ${successRate}, ${boostFactor}, NOW())
          ON CONFLICT (chunk_id, chunk_source)
          DO UPDATE SET
            total_shown = ${totalShown},
            total_helpful = ${totalHelpful},
            total_selected = ${totalSelected},
            success_rate = ${successRate},
            boost_factor = ${boostFactor},
            updated_at = NOW()
        `);
      } else {
        await dbHelper.run(sql`
          INSERT OR REPLACE INTO chunk_relevance_scores
            (chunk_id, chunk_source, total_shown, total_helpful, total_selected, success_rate, boost_factor, updated_at)
          VALUES
            (${chunkId}, ${chunkSource}, ${totalShown}, ${totalHelpful}, ${totalSelected}, ${successRate}, ${boostFactor}, ${Date.now()})
        `);
      }
    } catch (error) {
      logger.warn('Failed to update chunk relevance scores', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Get feedback stats for a chunk.
   */
  async getChunkStats(
    chunkId: string,
    chunkSource: ChunkSource,
  ): Promise<ChunkRelevanceScore | null> {
    await this.ensureInitialized();

    try {
      const rows = await dbHelper.all<{
        chunk_id: string;
        chunk_source: string;
        total_shown: number;
        total_helpful: number;
        total_selected: number;
        success_rate: number;
        boost_factor: number;
      }>(sql`
        SELECT * FROM chunk_relevance_scores
        WHERE chunk_id = ${chunkId} AND chunk_source = ${chunkSource}
        LIMIT 1
      `);

      if (rows.length === 0) return null;

      return {
        chunkId: rows[0].chunk_id,
        chunkSource: rows[0].chunk_source as ChunkSource,
        totalShown: Number(rows[0].total_shown),
        totalHelpful: Number(rows[0].total_helpful),
        totalSelected: Number(rows[0].total_selected),
        successRate: Number(rows[0].success_rate),
        boostFactor: Number(rows[0].boost_factor),
      };
    } catch (_) {
      return null;
    }
  }

  private async ensureSchema(): Promise<void> {
    try {
      if (isPostgres) {
        await dbHelper.run(sql`
          CREATE TABLE IF NOT EXISTS rag_feedback (
            id TEXT PRIMARY KEY,
            query_id TEXT NOT NULL,
            query_text TEXT NOT NULL,
            chunk_id TEXT NOT NULL,
            chunk_source TEXT NOT NULL DEFAULT 'refinement',
            was_helpful BOOLEAN NOT NULL,
            selected_by_user BOOLEAN DEFAULT FALSE,
            feedback_type TEXT DEFAULT 'implicit',
            session_id TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
          )
        `);
        await dbHelper.run(sql`
          CREATE TABLE IF NOT EXISTS chunk_relevance_scores (
            chunk_id TEXT NOT NULL,
            chunk_source TEXT NOT NULL DEFAULT 'refinement',
            total_shown INTEGER DEFAULT 0,
            total_helpful INTEGER DEFAULT 0,
            total_selected INTEGER DEFAULT 0,
            success_rate REAL DEFAULT 0.0,
            boost_factor REAL DEFAULT 1.0,
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (chunk_id, chunk_source)
          )
        `);
      } else {
        await dbHelper.run(sql`
          CREATE TABLE IF NOT EXISTS rag_feedback (
            id TEXT PRIMARY KEY,
            query_id TEXT NOT NULL,
            query_text TEXT NOT NULL,
            chunk_id TEXT NOT NULL,
            chunk_source TEXT NOT NULL DEFAULT 'refinement',
            was_helpful INTEGER NOT NULL DEFAULT 0,
            selected_by_user INTEGER DEFAULT 0,
            feedback_type TEXT DEFAULT 'implicit',
            session_id TEXT,
            created_at INTEGER NOT NULL
          )
        `);
        await dbHelper.run(sql`
          CREATE TABLE IF NOT EXISTS chunk_relevance_scores (
            chunk_id TEXT NOT NULL,
            chunk_source TEXT NOT NULL DEFAULT 'refinement',
            total_shown INTEGER DEFAULT 0,
            total_helpful INTEGER DEFAULT 0,
            total_selected INTEGER DEFAULT 0,
            success_rate REAL DEFAULT 0.0,
            boost_factor REAL DEFAULT 1.0,
            updated_at BIGINT NOT NULL,
            PRIMARY KEY (chunk_id, chunk_source)
          )
        `);
      }
    } catch (error) {
      logger.warn('Failed to ensure RAG feedback schema', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }
}

export const ragFeedbackService = new RAGFeedbackService();
