/**
 * Vector Search Service
 *
 * Provides native pgvector search when PostgreSQL is available,
 * with automatic fallback to in-memory cosine similarity for SQLite.
 *
 * Architecture:
 * - PostgreSQL + pgvector: uses HNSW index for O(log n) ANN search
 * - SQLite fallback: loads embeddings from JSON column, computes cosine in JS
 *
 * Embedding dimensions: 3072 (Qwen3-Embedding-8B 4096→3072 via Matryoshka
 * truncation; shorter embeddings are zero-padded by normalizeEmbedding).
 */

import { sql } from 'drizzle-orm';
import { dbHelper, isPostgres } from '../db';
import { logger } from '../utils/logger';

export type ChunkSource = 'refinement';

interface VectorSearchResult {
  chunkId: string;
  distance: number; // cosine distance (0 = identical, 2 = opposite)
  similarity: number; // 1 - distance (cosine similarity)
}

interface StoreEmbeddingInput {
  chunkId: string;
  chunkSource: ChunkSource;
  embedding: number[];
}

export class VectorSearchService {
  private pgvectorReady = false;
  private schemaChecked = false;

  /**
   * Check if native pgvector is available (PostgreSQL with vector extension).
   */
  async isNativeAvailable(): Promise<boolean> {
    if (!isPostgres) return false;
    if (this.schemaChecked) return this.pgvectorReady;

    try {
      await this.ensureSchema();
      // Test if vector extension works
      const result = await dbHelper.all<{ ok: number }>(
        sql`SELECT 1 as ok FROM pg_extension WHERE extname = 'vector' LIMIT 1`,
      );
      this.pgvectorReady = result.length > 0;
    } catch (_) {
      this.pgvectorReady = false;
    }
    this.schemaChecked = true;
    return this.pgvectorReady;
  }

  /**
   * Store embedding in pgvector table.
   * Only stores when PostgreSQL is available; no-op for SQLite.
   */
  async storeEmbedding(input: StoreEmbeddingInput): Promise<void> {
    if (!(await this.isNativeAvailable())) return;

    const vectorLiteral = `[${input.embedding.join(',')}]`;

    try {
      await dbHelper.run(sql`
        INSERT INTO chunk_embeddings (chunk_id, chunk_source, embedding)
        VALUES (${input.chunkId}, ${input.chunkSource}, ${vectorLiteral}::vector)
        ON CONFLICT (chunk_id, chunk_source)
        DO UPDATE SET embedding = ${vectorLiteral}::vector, created_at = NOW()
      `);
    } catch (error) {
      logger.warn('Failed to store embedding in pgvector', {
        error: error instanceof Error ? error : undefined,
        context: { chunkId: input.chunkId, source: input.chunkSource },
      });
    }
  }

  /**
   * Batch store embeddings.
   */
  async storeEmbeddings(inputs: StoreEmbeddingInput[]): Promise<number> {
    if (!(await this.isNativeAvailable())) return 0;

    let stored = 0;
    // Process in batches of 50 to avoid oversized queries
    const batchSize = 50;
    for (let i = 0; i < inputs.length; i += batchSize) {
      const batch = inputs.slice(i, i + batchSize);
      for (const input of batch) {
        try {
          await this.storeEmbedding(input);
          stored++;
        } catch (_) {
          // Individual failures don't block the batch
        }
      }
    }
    return stored;
  }

  async search(
    queryEmbedding: number[],
    source: ChunkSource,
    topK: number = 6,
    threshold: number = 0.0,
    filter?: {
      repoFullName?: string | null;
      includeGlobal?: boolean;
      freshnessDays?: number;
    },
  ): Promise<VectorSearchResult[]> {
    if (await this.isNativeAvailable()) {
      return this.searchNative(queryEmbedding, source, topK, threshold, filter);
    }
    return this.searchFallback(queryEmbedding, source, topK, threshold);
  }

  /**
   * Native pgvector search using HNSW index.
   * Uses cosine distance operator (<=>) and joins with original tables for metadata pre-filtering.
   */
  private async searchNative(
    queryEmbedding: number[],
    source: ChunkSource,
    topK: number,
    threshold: number,
    filter?: {
      repoFullName?: string | null;
      includeGlobal?: boolean;
      freshnessDays?: number;
    },
  ): Promise<VectorSearchResult[]> {
    const vectorLiteral = `[${queryEmbedding.join(',')}]`;

    const repoFullName = filter?.repoFullName?.trim() || null;
    const includeGlobal = filter?.includeGlobal === true;
    const freshnessDays = filter?.freshnessDays ?? 0;
    const cutoff = freshnessDays ? Date.now() - freshnessDays * 24 * 60 * 60 * 1000 : 0;

    let whereClause = sql`WHERE ce.chunk_source = 'refinement'`;
    if (cutoff > 0) {
      whereClause = sql`${whereClause} AND doc.updated_at >= ${cutoff}`;
    }
    if (repoFullName) {
      if (includeGlobal) {
        whereClause = sql`${whereClause} AND (doc.repo_full_name = ${repoFullName} OR doc.repo_full_name IS NULL)`;
      } else {
        whereClause = sql`${whereClause} AND doc.repo_full_name = ${repoFullName}`;
      }
    } else {
      if (!includeGlobal) {
        whereClause = sql`${whereClause} AND doc.repo_full_name IS NULL`;
      }
    }

    const query = sql`
      SELECT
        ce.chunk_id,
        ce.embedding <=> ${vectorLiteral}::vector AS distance
      FROM chunk_embeddings ce
      JOIN refinement_rag_documents doc ON ce.chunk_id = doc.id
      ${whereClause}
      ORDER BY ce.embedding <=> ${vectorLiteral}::vector
      LIMIT ${topK * 2}
    `;

    try {
      const rows = await dbHelper.all<{
        chunk_id: string;
        distance: number;
      }>(query);

      return rows
        .map((row) => ({
          chunkId: row.chunk_id,
          distance: Number(row.distance),
          similarity: 1 - Number(row.distance),
        }))
        .filter((r) => r.similarity >= threshold)
        .slice(0, topK);
    } catch (error) {
      logger.warn('pgvector search failed, falling back to JS', {
        error: error instanceof Error ? error : undefined,
      });
      return this.searchFallback(queryEmbedding, source, topK, threshold);
    }
  }

  /**
   * Fallback: Load embeddings from JSON column in chunks table and compute cosine in JS.
   * Used when SQLite is the backend or pgvector is unavailable.
   */
  private async searchFallback(
    _queryEmbedding: number[],
    _source: ChunkSource,
    _topK: number,
    _threshold: number,
  ): Promise<VectorSearchResult[]> {
    // `refinement` (a única fonte hoje) não tem embeddings persistidos para
    // fallback JS — busca semântica em modo fallback retorna vazio até esse
    // caminho ser implementado.
    return [];
  }

  /**
   * Ensure the pgvector schema exists.
   */
  private async ensureSchema(): Promise<void> {
    if (!isPostgres) return;

    try {
      await dbHelper.run(sql`
        CREATE TABLE IF NOT EXISTS chunk_embeddings (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          chunk_id TEXT NOT NULL,
          chunk_source TEXT NOT NULL DEFAULT 'refinement',
          embedding vector(3072) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(chunk_id, chunk_source)
        )
      `);
    } catch (error) {
      // If vector extension is not installed, this will fail gracefully
      logger.warn('Could not ensure pgvector schema (extension may not be installed)', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Delete embedding for a chunk.
   */
  async deleteEmbedding(chunkId: string, source: ChunkSource): Promise<void> {
    if (!(await this.isNativeAvailable())) return;
    await dbHelper.run(
      sql`DELETE FROM chunk_embeddings WHERE chunk_id = ${chunkId} AND chunk_source = ${source}`,
    );
  }

  /**
   * Get embedding count by source.
   */
  async getCount(source?: ChunkSource): Promise<number> {
    if (!(await this.isNativeAvailable())) return 0;

    const rows = source
      ? await dbHelper.all<{ count: number }>(
          sql`SELECT COUNT(*) as count FROM chunk_embeddings WHERE chunk_source = ${source}`,
        )
      : await dbHelper.all<{ count: number }>(sql`SELECT COUNT(*) as count FROM chunk_embeddings`);

    return Number(rows[0]?.count || 0);
  }
}

export const vectorSearchService = new VectorSearchService();
