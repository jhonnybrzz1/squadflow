import { openAIService } from './openai-ai';
import { dbHelper, isPostgres } from '../db';
import { sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { logger } from '../utils/logger';
import { embeddingsManager } from './llm-embeddings-operations';

/**
 * Embedding Service with caching to database.
 * Uses the configured local/remote embedding provider and normalizes the
 * effective vector to 3072 dimensions when supported.
 * Supports both SQLite and PostgreSQL.
 */
export class EmbeddingService {
  private initialized = false;

  constructor() {
    // Schema will be ensured on first use (async)
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.ensureSchema();
    this.initialized = true;
  }

  /**
   * Get embedding for text, using cache if available.
   */
  async getEmbedding(text: string): Promise<number[]> {
    await this.ensureInitialized();
    const model = embeddingsManager.getEmbeddingModel();
    const dimensions = embeddingsManager.getEmbeddingDimensions();
    const hash = this.hashText(text, model, dimensions);
    const cached = await this.getFromCache(hash, model, dimensions);
    if (cached) {
      return cached;
    }

    const embedding = await openAIService.generateEmbedding(text);
    await this.saveToCache(hash, embedding, model, dimensions);
    return embedding;
  }

  /**
   * Get embeddings for multiple texts, using cache where available.
   */
  async getEmbeddings(texts: string[]): Promise<number[][]> {
    await this.ensureInitialized();
    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];
    const model = embeddingsManager.getEmbeddingModel();
    const dimensions = embeddingsManager.getEmbeddingDimensions();

    // Check cache first
    for (let i = 0; i < texts.length; i++) {
      const hash = this.hashText(texts[i], model, dimensions);
      const cached = await this.getFromCache(hash, model, dimensions);
      if (cached) {
        results[i] = cached;
      } else {
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i]);
      }
    }

    // Fetch uncached embeddings in batch
    if (uncachedTexts.length > 0) {
      const newEmbeddings = await openAIService.generateEmbeddings(uncachedTexts);
      for (let j = 0; j < uncachedIndices.length; j++) {
        const originalIndex = uncachedIndices[j];
        const embedding = newEmbeddings[j];
        results[originalIndex] = embedding;
        await this.saveToCache(
          this.hashText(texts[originalIndex], model, dimensions),
          embedding,
          model,
          dimensions,
        );
      }
    }

    return results as number[][];
  }

  /**
   * Compute cosine similarity between two vectors.
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /**
   * Serialize embedding to string for storage.
   */
  serializeEmbedding(embedding: number[]): string {
    return JSON.stringify(embedding);
  }

  /**
   * Deserialize embedding from storage.
   */
  deserializeEmbedding(data: string): number[] {
    try {
      return JSON.parse(data);
    } catch (err) {
      // CRIT-6: uma linha de embedding corrompida no cache/DB não deve
      // crashar o caller. Todos os chamadores atuais já rodam isto dentro de
      // um try/catch (skip do item corrompido) — aqui só garantimos que o
      // motivo fica logado antes de propagar.
      logger.warn('Falha ao desserializar embedding armazenado', {
        error: err instanceof Error ? err : undefined,
        context: { dataPreview: data.slice(0, 80) },
      });
      throw new Error('Invalid stored embedding JSON', {
        cause: err instanceof Error ? err : undefined,
      });
    }
  }

  private hashText(text: string, model: string, dimensions: number): string {
    return createHash('sha256').update(`${text}|${model}|${dimensions}`).digest('hex').slice(0, 32);
  }

  private async getFromCache(
    hash: string,
    model: string,
    dimensions: number,
  ): Promise<number[] | null> {
    try {
      const rows = await dbHelper.all<{ embedding: string }>(
        sql`SELECT embedding FROM embedding_cache WHERE text_hash = ${hash} AND model_id = ${model} AND dimensions = ${dimensions} LIMIT 1`,
      );

      if (rows.length === 0) return null;
      return this.deserializeEmbedding(rows[0].embedding);
    } catch (_) {
      return null;
    }
  }

  private async saveToCache(
    hash: string,
    embedding: number[],
    model: string,
    dimensions: number,
  ): Promise<void> {
    try {
      const serialized = this.serializeEmbedding(embedding);
      if (isPostgres) {
        // PostgreSQL: use ON CONFLICT
        await dbHelper.run(sql`
          INSERT INTO embedding_cache (text_hash, embedding, model_id, dimensions, created_at)
          VALUES (${hash}, ${serialized}, ${model}, ${dimensions}, ${Date.now()})
          ON CONFLICT (text_hash, model_id, dimensions) DO UPDATE SET embedding = ${serialized}, created_at = ${Date.now()}
        `);
      } else {
        // SQLite: use INSERT OR REPLACE
        await dbHelper.run(sql`
          INSERT OR REPLACE INTO embedding_cache (text_hash, embedding, model_id, dimensions, created_at)
          VALUES (${hash}, ${serialized}, ${model}, ${dimensions}, ${Date.now()})
        `);
      }
    } catch (error) {
      logger.warn('Falha ao armazenar embedding em cache', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  private async ensureSchema(): Promise<void> {
    try {
      if (isPostgres) {
        await dbHelper.run(sql`
          CREATE TABLE IF NOT EXISTS embedding_cache (
            text_hash TEXT NOT NULL,
            embedding TEXT NOT NULL,
            model_id TEXT NOT NULL,
            dimensions INTEGER NOT NULL,
            created_at BIGINT NOT NULL,
            PRIMARY KEY (text_hash, model_id, dimensions)
          )
        `);
      } else {
        await dbHelper.run(sql`
          CREATE TABLE IF NOT EXISTS embedding_cache (
            text_hash TEXT NOT NULL,
            embedding TEXT NOT NULL,
            model_id TEXT NOT NULL,
            dimensions INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (text_hash, model_id, dimensions)
          )
        `);
      }
    } catch (error) {
      logger.warn('Não foi possível garantir schema embedding_cache', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }
}

export const embeddingService = new EmbeddingService();
