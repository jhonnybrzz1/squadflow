import { sql } from 'drizzle-orm';
import { dbRun, dbAll } from '../utils/db-utils';
import { db as defaultDb, type DbClient } from '../db';
import { logger } from '../utils/logger';

export interface QueryTypeWeights {
  queryType: string;
  keywordWeight: number;
  semanticWeight: number;
}

// Seed inicial conforme spec A-1.
export const DEFAULT_QUERY_TYPE_WEIGHTS: QueryTypeWeights[] = [
  { queryType: 'factual', keywordWeight: 0.7, semanticWeight: 0.3 },
  { queryType: 'contextual', keywordWeight: 0.3, semanticWeight: 0.7 },
  { queryType: 'procedural', keywordWeight: 0.6, semanticWeight: 0.4 },
  { queryType: 'exploratory', keywordWeight: 0.2, semanticWeight: 0.8 },
];

export const DEFAULT_HYBRID_WEIGHTS = { keywordWeight: 0.5, semanticWeight: 0.5 };

export class QueryTypeWeightsService {
  private cache: Map<string, QueryTypeWeights> | null = null;
  private cacheTimestamp = 0;
  private readonly cacheTtlMs = 60_000;

  constructor(private readonly database: DbClient = defaultDb) {}

  /**
   * A-1: garante a tabela e popula o seed inicial de forma idempotente.
   */
  async ensureSchemaAndSeed(): Promise<void> {
    try {
      await dbRun(
        this.database,
        sql`
          CREATE TABLE IF NOT EXISTS query_type_weights (
            query_type TEXT PRIMARY KEY NOT NULL,
            keyword_weight REAL NOT NULL,
            semantic_weight REAL NOT NULL
          )
        `,
      );

      for (const row of DEFAULT_QUERY_TYPE_WEIGHTS) {
        await dbRun(
          this.database,
          sql`
            INSERT INTO query_type_weights (query_type, keyword_weight, semantic_weight)
            VALUES (${row.queryType}, ${row.keywordWeight}, ${row.semanticWeight})
            ON CONFLICT(query_type) DO UPDATE SET
              keyword_weight = excluded.keyword_weight,
              semantic_weight = excluded.semantic_weight
          `,
        );
      }

      logger.info('A-1: query_type_weights schema e seed garantidos');
    } catch (error) {
      logger.warn('A-1: falha ao garantir query_type_weights', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * A-1: retorna os pesos para um queryType. Fallback silencioso para 0.5/0.5.
   */
  async getWeights(
    queryType: string | undefined,
  ): Promise<{ keywordWeight: number; semanticWeight: number; matched: boolean }> {
    if (!queryType || queryType.trim() === '') {
      return { ...DEFAULT_HYBRID_WEIGHTS, matched: false };
    }

    const normalized = queryType.trim().toLowerCase();

    if (this.cache && Date.now() - this.cacheTimestamp < this.cacheTtlMs) {
      const cached = this.cache.get(normalized);
      if (cached) {
        return {
          keywordWeight: cached.keywordWeight,
          semanticWeight: cached.semanticWeight,
          matched: true,
        };
      }
      if (this.cache.has(normalized)) {
        // cache sabe que tipo existe mas não está? não; cache com has sem value não ocorre.
      }
    }

    try {
      const rows = (await dbAll(
        this.database,
        sql`SELECT query_type, keyword_weight, semantic_weight FROM query_type_weights WHERE query_type = ${normalized}`,
      )) as Array<{ query_type: string; keyword_weight: number; semantic_weight: number }>;

      if (rows.length === 0) {
        logger.warn('A-1: queryType desconhecido, fallback para 0.5/0.5', {
          context: { queryType: normalized },
        });
        return { ...DEFAULT_HYBRID_WEIGHTS, matched: false };
      }

      const row = rows[0];
      return {
        keywordWeight: row.keyword_weight,
        semanticWeight: row.semantic_weight,
        matched: true,
      };
    } catch (error) {
      logger.warn('A-1: falha no lookup de queryType, fallback para 0.5/0.5', {
        error: error instanceof Error ? error : undefined,
        context: { queryType: normalized },
      });
      return { ...DEFAULT_HYBRID_WEIGHTS, matched: false };
    }
  }

  /**
   * A-1: recarrega cache em memória com todos os pesos.
   */
  async refreshCache(): Promise<void> {
    try {
      const rows = (await dbAll(
        this.database,
        sql`SELECT query_type, keyword_weight, semantic_weight FROM query_type_weights`,
      )) as Array<{ query_type: string; keyword_weight: number; semantic_weight: number }>;

      this.cache = new Map();
      for (const row of rows) {
        this.cache.set(row.query_type, {
          queryType: row.query_type,
          keywordWeight: row.keyword_weight,
          semanticWeight: row.semantic_weight,
        });
      }
      this.cacheTimestamp = Date.now();
    } catch (error) {
      logger.warn('A-1: falha ao recarregar cache de query_type_weights', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }
}

export const queryTypeWeightsService = new QueryTypeWeightsService();
