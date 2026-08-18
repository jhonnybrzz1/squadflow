/**
 * RetrievalService Tests
 *
 * Tests for the unified RetrievalService:
 * - Unification of refinement and product roles RAG
 * - Correct query embedding generation and HNSW search
 * - Local embeddings warning (never serve in silence)
 * - Scope filtering (repo lock, role filters, tag filters)
 * - Freshness/updated_at filtering
 * - Over-fetching for LLM reordering
 * - Native pgvector pre-filtering join queries (HNSW pre-filter)
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mocks do banco de dados e do logger
vi.mock('../server/db', () => ({
  isPostgres: false,
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    run: vi.fn(),
    execute: vi.fn().mockResolvedValue(undefined),
  },
  dbHelper: {
    run: vi.fn().mockResolvedValue(undefined),
    all: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock embeddingsManager
vi.mock('../server/services/llm-embeddings-operations', () => ({
  embeddingsManager: {
    generateEmbedding: vi.fn().mockResolvedValue(new Array(3072).fill(0.1)),
    isUsingLocalEmbeddingsForRAG: vi.fn().mockReturnValue(false),
    isDegraded: vi.fn().mockReturnValue(false),
    isUsingLocalEmbeddings: vi.fn().mockReturnValue(false),
  },
}));

// Mock vectorSearchService
vi.mock('../server/services/vector-search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/vector-search')>();
  return {
    ...actual,
    vectorSearchService: {
      isNativeAvailable: vi.fn().mockResolvedValue(false),
      search: vi.fn().mockResolvedValue([]),
    },
  };
});

// Mock llmReorderService
vi.mock('../server/services/llm-reorder', () => ({
  llmReorderService: {
    isAvailable: vi.fn().mockReturnValue(false),
    rerank: vi.fn().mockResolvedValue({
      results: [],
      fallbackUsed: false,
      rerankLatencyMs: 0,
      rerankCostUsd: 0,
      provider: 'openrouter',
    }),
  },
}));

// Mock db-utils for fallback queries
vi.mock('../server/utils/db-utils', () => ({
  dbAll: vi.fn().mockResolvedValue([]),
  dbRun: vi.fn().mockResolvedValue(undefined),
  escapeLikePattern: (value: string) => value,
}));

vi.mock('../server/services/query-type-weights', () => ({
  queryTypeWeightsService: {
    getWeights: vi
      .fn()
      .mockResolvedValue({ keywordWeight: 0.5, semanticWeight: 0.5, matched: false }),
    ensureSchemaAndSeed: vi.fn().mockResolvedValue(undefined),
  },
}));

import { logger } from '../server/utils/logger';
import { dbAll } from '../server/utils/db-utils';
import { dbHelper } from '../server/db';
import { retrievalService } from '../server/services/retrieval-service';
import { embeddingsManager } from '../server/services/llm-embeddings-operations';
import { vectorSearchService } from '../server/services/vector-search';
import { llmReorderService } from '../server/services/llm-reorder';
import { embeddingService } from '../server/services/embedding-service';
import { ragFeedbackService } from '../server/services/rag-feedback';
import { queryTypeWeightsService } from '../server/services/query-type-weights';

describe('RetrievalService — Unificação e Governança', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Governança de Local Embeddings (Não rodar em silêncio)', () => {
    it('deve emitir um warning sonoro no logger se local embeddings para RAG estiver ativo', async () => {
      vi.mocked(embeddingsManager.isUsingLocalEmbeddingsForRAG).mockReturnValueOnce(true);
      vi.mocked(dbAll).mockResolvedValueOnce([]);

      await retrievalService.retrieve('consulta qualquer', {
        source: 'refinement',
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('WARNING: RAG is using local hash-based embeddings!'),
        expect.any(Object),
      );
    });

    it('não deve emitir warning se local embeddings para RAG estiver desativado', async () => {
      vi.mocked(embeddingsManager.isUsingLocalEmbeddingsForRAG).mockReturnValueOnce(false);
      vi.mocked(dbAll).mockResolvedValueOnce([]);

      await retrievalService.retrieve('consulta qualquer', {
        source: 'refinement',
      });

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('Fallback SQLite e similaridade em memória', () => {
    it('deve buscar e computar similaridade para refinamentos no SQLite', async () => {
      vi.mocked(vectorSearchService.isNativeAvailable).mockResolvedValue(false);

      const mockRows = [
        {
          id: '1',
          source_key: 'PRD_1',
          doc_type: 'PRD',
          demand_id: 10,
          content: 'checkout performance',
          repo_full_name: 'test/repo',
          updated_at: Date.now(),
          embedding: '[0.1]',
        },
        {
          id: '2',
          source_key: 'PRD_2',
          doc_type: 'PRD',
          demand_id: 20,
          content: 'some other content',
          repo_full_name: 'test/repo',
          updated_at: Date.now(),
          embedding: '[0.2]',
        },
      ];

      vi.mocked(dbAll)
        .mockResolvedValueOnce(mockRows) // para o retrieveFallback
        .mockResolvedValueOnce([]) // para o retrieveKeyword (sem matches)
        .mockResolvedValueOnce([mockRows[0]]); // para o hydrateMatches

      vi.spyOn(embeddingService, 'deserializeEmbedding').mockImplementation((str) => {
        return str === '[0.1]' ? [0.1] : [0.2];
      });
      vi.spyOn(embeddingService, 'cosineSimilarity').mockImplementation((a, b) => {
        return b[0] === 0.1 ? 0.95 : 0.2;
      });

      const results = await retrievalService.retrieve('performance check', {
        source: 'refinement',
        topK: 1,
        minSimilarity: 0.5,
        scope: { repoFullName: 'test/repo' },
      });

      expect(results.length).toBe(1);
      expect(results[0].sourceKey).toBe('PRD_1');
      // Spec 10259 T6: score híbrido com pesos default 0.5/0.5 e sem match keyword.
      expect(results[0].score).toBe(0.475);
    });

    it('B-1 (avaliação de RAG 2026-07-26): registra feedback implícito para os chunks retornados', async () => {
      vi.mocked(vectorSearchService.isNativeAvailable).mockResolvedValue(false);

      const mockRows = [
        {
          id: 'chunk-a',
          source_key: 'PRD_A',
          doc_type: 'PRD',
          demand_id: 1,
          content: 'conteudo a',
          repo_full_name: null,
          updated_at: Date.now(),
          embedding: '[0.1]',
        },
      ];
      vi.mocked(dbAll).mockResolvedValueOnce(mockRows).mockResolvedValueOnce(mockRows);
      vi.spyOn(embeddingService, 'deserializeEmbedding').mockReturnValue([0.1]);
      vi.spyOn(embeddingService, 'cosineSimilarity').mockReturnValue(0.9);

      const recordSpy = vi
        .spyOn(ragFeedbackService, 'recordImplicitFeedback')
        .mockImplementation(() => {});

      await retrievalService.retrieve('busca qualquer', {
        source: 'refinement',
        minSimilarity: 0.5,
      });

      expect(recordSpy).toHaveBeenCalledOnce();
      const [, queryText, chunkIds, source] = recordSpy.mock.calls[0];
      expect(queryText).toBe('busca qualquer');
      expect(chunkIds).toEqual(['chunk-a']);
      expect(source).toBe('refinement');
    });

    it('não registra feedback quando não há matches', async () => {
      vi.mocked(vectorSearchService.isNativeAvailable).mockResolvedValue(false);
      vi.mocked(dbAll).mockResolvedValueOnce([]);

      const recordSpy = vi
        .spyOn(ragFeedbackService, 'recordImplicitFeedback')
        .mockImplementation(() => {});

      await retrievalService.retrieve('busca sem match', { source: 'refinement' });

      expect(recordSpy).not.toHaveBeenCalled();
    });
  });

  describe('B-2: log estruturado de performance do retrieval', () => {
    it('deve logar embeddingMs, retrievalMs, topScores e avgChunkTokens', async () => {
      vi.mocked(vectorSearchService.isNativeAvailable).mockResolvedValue(false);

      const mockRows = [
        {
          id: 'chunk-a',
          source_key: 'PRD_A',
          doc_type: 'PRD',
          demand_id: 1,
          content: 'conteudo de teste com trinta caracteres',
          repo_full_name: null,
          updated_at: Date.now(),
          embedding: '[0.1]',
        },
      ];
      vi.mocked(dbAll)
        .mockResolvedValueOnce(mockRows) // retrieveFallback
        .mockResolvedValueOnce(mockRows); // hydrateMatches

      vi.spyOn(embeddingService, 'deserializeEmbedding').mockReturnValue([0.1]);
      vi.spyOn(embeddingService, 'cosineSimilarity').mockReturnValue(0.9);

      await retrievalService.retrieve('busca qualquer', {
        source: 'refinement',
        minSimilarity: 0.5,
        topK: 1,
        keywordWeight: 0,
        semanticWeight: 1,
      });

      const infoCall = vi
        .mocked(logger.info)
        .mock.calls.find((call) => call[0] === 'RAG retrieval completed');
      expect(infoCall).toBeDefined();

      const context = (infoCall![1] as Record<string, unknown>).context as Record<string, unknown>;
      expect(context.embeddingMs).toBeGreaterThanOrEqual(0);
      expect(context.retrievalMs).toBeGreaterThanOrEqual(0);
      expect(context.latencyMs).toBeGreaterThan(0);
      expect(Array.isArray(context.topScores)).toBe(true);
      expect((context.topScores as number[]).length).toBe(1);
      expect(context.avgChunkTokens).toBeGreaterThan(0);
      expect(context.resultCount).toBe(1);
    });

    it('deve logar topScores vazio e avgChunkTokens zero quando não há matches', async () => {
      vi.mocked(vectorSearchService.isNativeAvailable).mockResolvedValue(false);
      vi.mocked(dbAll).mockResolvedValueOnce([]);

      await retrievalService.retrieve('busca sem match', { source: 'refinement' });

      const infoCall = vi
        .mocked(logger.info)
        .mock.calls.find((call) => call[0] === 'RAG retrieval completed');
      expect(infoCall).toBeDefined();

      const context = (infoCall![1] as Record<string, unknown>).context as Record<string, unknown>;
      expect(context.topScores).toEqual([]);
      expect(context.avgChunkTokens).toBe(0);
      expect(context.resultCount).toBe(0);
    });
  });

  describe('Over-fetching e Reranking (Cohere)', () => {
    it('deve fazer over-fetch (top-15) e aplicar LLM reorder se ativado', async () => {
      vi.mocked(vectorSearchService.isNativeAvailable).mockResolvedValue(true);
      vi.mocked(llmReorderService.isAvailable).mockReturnValue(true);

      const mockMatches = [{ chunkId: 'chunk-0', similarity: 0.9 }];
      vi.mocked(vectorSearchService.search).mockResolvedValue(mockMatches);

      const mockHydrated = [
        {
          id: 'chunk-0',
          source_key: 'PRD_0',
          doc_type: 'PRD',
          demand_id: 100,
          content: 'conteudo doc 0',
          repo_full_name: 'org/repo',
          updated_at: Date.now(),
        },
      ];

      vi.mocked(dbAll)
        .mockResolvedValueOnce([]) // para o retrieveKeyword
        .mockResolvedValueOnce(mockHydrated); // para o hydrateMatches

      const rerankedResult = [
        {
          content: 'conteudo doc 0',
          source: 'chunk-0',
          artigo_ou_secao: 'PRD',
          originalScore: 0.9,
          rerankScore: 0.95,
          index: 0,
        },
      ];
      vi.mocked(llmReorderService.rerank).mockResolvedValue({
        results: rerankedResult,
        fallbackUsed: false,
        rerankLatencyMs: 200,
        rerankCostUsd: 0.0002,
        provider: 'openrouter',
      });

      const results = await retrievalService.retrieve('busca', {
        source: 'refinement',
        topK: 2,
        useReranking: true,
        scope: { repoFullName: 'org/repo' },
      });

      expect(vectorSearchService.search).toHaveBeenCalledWith(
        expect.any(Array),
        'refinement',
        15, // over-fetch fetchK = Math.max(15, topK * 2) — incidente rerank 2026-07-17
        0.0,
        {
          repoFullName: 'org/repo',
          includeGlobal: undefined,
          freshnessDays: undefined,
          filterByRole: undefined,
          filterByTags: undefined,
        },
      );

      expect(llmReorderService.rerank).toHaveBeenCalledOnce();
      expect(results.length).toBe(1);
      expect(results[0].sourceKey).toBe('PRD_0');
      expect(results[0].score).toBe(0.95);
    });
  });

  describe('pgvector Native Pre-filtering (pre-filter in HNSW - Finding #4)', () => {
    // Helper recursivo para extrair e normalizar a string SQL de objetos SQL aninhados do Drizzle
    function getNormalizedSql(sqlObj: any): string {
      if (!sqlObj) return '';
      if (Array.isArray(sqlObj.queryChunks)) {
        return sqlObj.queryChunks.map(getNormalizedSql).join(' ').replace(/\s+/g, ' ').trim();
      }
      if (typeof sqlObj === 'string') return sqlObj;
      if (sqlObj && Array.isArray(sqlObj.value)) return sqlObj.value.join(' ');
      if (sqlObj && sqlObj.queryChunks) return getNormalizedSql(sqlObj.queryChunks);
      return '';
    }

    it('deve fazer busca pgvector nativa com junção e pré-filtros para refinamento', async () => {
      // Re-importa o modulo real da busca vetorial nativa para exercitar o gerador de queries
      const { VectorSearchService } = await import('../server/services/vector-search');
      const vss = new VectorSearchService();

      vi.spyOn(vss, 'isNativeAvailable').mockResolvedValue(true);

      const sqlQueries: any[] = [];
      vi.mocked(dbHelper.all).mockImplementation(async (query) => {
        sqlQueries.push(query);
        return [{ chunk_id: 'chunk-123', distance: 0.1 }];
      });

      await vss.search(new Array(3072).fill(0.1), 'refinement', 5, 0.3, {
        repoFullName: 'org/repo',
        includeGlobal: true,
        freshnessDays: 10,
      });

      expect(dbHelper.all).toHaveBeenCalledOnce();
      const generatedSql = getNormalizedSql(sqlQueries[0]);
      expect(generatedSql).toContain('JOIN refinement_rag_documents doc ON ce.chunk_id = doc.id');
      expect(generatedSql).toContain('doc.updated_at >=');
      expect(generatedSql).toContain('doc.repo_full_name =');
    });
  });

  describe('A-1: override de pesos por queryType', () => {
    it('aplica pesos do queryType quando fornecido', async () => {
      vi.mocked(queryTypeWeightsService.getWeights).mockResolvedValueOnce({
        keywordWeight: 0.7,
        semanticWeight: 0.3,
        matched: true,
      });
      vi.mocked(dbAll).mockResolvedValueOnce([]);

      await retrievalService.retrieve('preço do produto X', {
        source: 'refinement',
        queryType: 'factual',
      });

      expect(queryTypeWeightsService.getWeights).toHaveBeenCalledWith('factual');
      expect(logger.info).toHaveBeenCalledWith(
        'A-1: hybrid retrieval weights',
        expect.objectContaining({
          context: expect.objectContaining({
            queryType: 'factual',
            keywordWeight: 0.7,
            semanticWeight: 0.3,
            matched: true,
          }),
        }),
      );
    });

    it('fallback para 0.5/0.5 quando queryType é desconhecido', async () => {
      vi.mocked(queryTypeWeightsService.getWeights).mockResolvedValueOnce({
        keywordWeight: 0.5,
        semanticWeight: 0.5,
        matched: false,
      });
      vi.mocked(dbAll).mockResolvedValueOnce([]);

      await retrievalService.retrieve('preço do produto X', {
        source: 'refinement',
        queryType: 'inexistente',
      });

      expect(queryTypeWeightsService.getWeights).toHaveBeenCalledWith('inexistente');
      expect(logger.info).toHaveBeenCalledWith(
        'A-1: hybrid retrieval weights',
        expect.objectContaining({
          context: expect.objectContaining({
            queryType: 'inexistente',
            keywordWeight: 0.5,
            semanticWeight: 0.5,
            matched: false,
          }),
        }),
      );
    });

    it('preserva regressão sem queryType (default 0.5/0.5)', async () => {
      vi.mocked(queryTypeWeightsService.getWeights).mockResolvedValueOnce({
        keywordWeight: 0.5,
        semanticWeight: 0.5,
        matched: false,
      });
      vi.mocked(dbAll).mockResolvedValueOnce([]);

      await retrievalService.retrieve('preço do produto X', {
        source: 'refinement',
      });

      expect(queryTypeWeightsService.getWeights).toHaveBeenCalledWith(undefined);
      expect(logger.info).toHaveBeenCalledWith(
        'A-1: hybrid retrieval weights',
        expect.objectContaining({
          context: expect.objectContaining({
            queryType: null,
            keywordWeight: 0.5,
            semanticWeight: 0.5,
            matched: false,
          }),
        }),
      );
    });

    it('pesos explícitos keywordWeight/semanticWeight prevalecem sobre queryType', async () => {
      vi.mocked(queryTypeWeightsService.getWeights).mockResolvedValueOnce({
        keywordWeight: 0.9,
        semanticWeight: 0.1,
        matched: true,
      });
      vi.mocked(dbAll).mockResolvedValueOnce([]);

      await retrievalService.retrieve('preço do produto X', {
        source: 'refinement',
        queryType: 'factual',
        keywordWeight: 0.2,
        semanticWeight: 0.8,
      });

      // Como keywordWeight/semanticWeight são explícitos, getWeights não deve ser chamado
      expect(queryTypeWeightsService.getWeights).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        'A-1: hybrid retrieval weights',
        expect.objectContaining({
          context: expect.objectContaining({
            keywordWeight: 0.2,
            semanticWeight: 0.8,
          }),
        }),
      );
    });
  });
});
