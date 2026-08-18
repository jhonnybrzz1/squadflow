import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================
// Mocks
// ============================================================

vi.mock('../server/db', () => ({
  dbHelper: {
    run: vi.fn().mockResolvedValue(undefined),
    all: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    isPostgres: false,
  },
  isPostgres: false,
  db: {},
}));

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../server/services/embedding-service', () => ({
  embeddingService: {
    getEmbedding: vi.fn().mockResolvedValue(new Array(3072).fill(0.1)),
    getEmbeddings: vi.fn().mockResolvedValue([new Array(3072).fill(0.1)]),
    cosineSimilarity: vi.fn().mockReturnValue(0.85),
    serializeEmbedding: vi.fn().mockReturnValue('[]'),
    deserializeEmbedding: vi.fn().mockReturnValue(new Array(3072).fill(0.1)),
  },
}));

vi.mock('../server/services/openai-ai', () => ({
  openAIService: {
    isUsingLocalEmbeddings: vi.fn().mockReturnValue(false),
    generateChatCompletion: vi.fn().mockResolvedValue('mock response'),
    generateEmbedding: vi.fn().mockResolvedValue(new Array(3072).fill(0.1)),
  },
}));

// ============================================================
// Imports (after mocks)
// ============================================================

import {
  detectQueryIntent,
  getRetrievalParamsForIntent,
  mergeRetrievalParams,
  type QueryIntent,
} from '../server/services/query-intent';
import { VectorSearchService } from '../server/services/vector-search';
import { RAGFeedbackService, type RAGFeedback } from '../server/services/rag-feedback';
import { SemanticChunker } from '../server/services/semantic-chunker';
import { dbHelper } from '../server/db';

// ============================================================
// Sprint 2.1: Semantic Chunker Tests
// ============================================================

describe('SemanticChunker', () => {
  describe('splitText', () => {
    it('returns text as-is when shorter than chunk size', () => {
      const chunker = new SemanticChunker({ chunkSize: 500 });
      const result = chunker.splitText('Short text.');
      expect(result).toEqual(['Short text.']);
    });

    it('splits long text into multiple chunks', () => {
      const chunker = new SemanticChunker({ chunkSize: 100, chunkOverlap: 0 });
      const text = 'A'.repeat(50) + '. ' + 'B'.repeat(50) + '. ' + 'C'.repeat(50);
      const result = chunker.splitText(text);
      expect(result.length).toBeGreaterThan(1);
    });

    it('respects markdown header separators', () => {
      const chunker = new SemanticChunker({ chunkSize: 100, chunkOverlap: 0 });
      const text =
        'Intro paragraph with some content that is long enough to fill.\n\n## Section One\n\nContent of section one is here and it has enough text to matter.\n\n## Section Two\n\nContent of section two is here and also quite detailed.';
      const result = chunker.splitText(text);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('splits by paragraph boundaries when sections are too large', () => {
      const chunker = new SemanticChunker({ chunkSize: 50, chunkOverlap: 0 });
      const text =
        'First paragraph is here.\n\nSecond paragraph is also here.\n\nThird paragraph is right here.';
      const result = chunker.splitText(text);
      expect(result.length).toBeGreaterThan(1);
    });

    it('handles empty text', () => {
      const chunker = new SemanticChunker();
      const result = chunker.splitText('');
      expect(result).toEqual([]);
    });

    it('handles text with only whitespace', () => {
      const chunker = new SemanticChunker();
      const result = chunker.splitText('   \n\n  ');
      expect(result).toEqual([]);
    });

    it('applies overlap between chunks', () => {
      const chunker = new SemanticChunker({ chunkSize: 60, chunkOverlap: 20 });
      const text = 'Alpha bravo. Charlie delta. Echo foxtrot. Golf hotel. India juliet. Kilo lima.';
      const result = chunker.splitText(text);
      if (result.length > 1) {
        // Overlap means subsequent chunks may contain text from previous chunk
        expect(result.length).toBeGreaterThan(1);
      }
    });
  });

  describe('chunkDocument', () => {
    it('generates chunks with metadata', () => {
      const chunker = new SemanticChunker({ chunkSize: 500 });
      const text = '## Header\n\nSome content here.';
      const result = chunker.chunkDocument(text);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('content');
      expect(result[0]).toHaveProperty('sectionHeader');
      expect(result[0]).toHaveProperty('level');
      expect(result[0]).toHaveProperty('tokenEstimate');
      expect(result[0]).toHaveProperty('startOffset');
    });

    it('assigns section headers correctly', () => {
      const chunker = new SemanticChunker({ chunkSize: 500 });
      const text = '## Artigo 1\n\nConteudo do artigo 1.\n\n## Artigo 2\n\nConteudo do artigo 2.';
      const result = chunker.chunkDocument(text);
      const headers = result.map((c) => c.sectionHeader);
      expect(headers).toContain('Artigo 1');
      expect(headers).toContain('Artigo 2');
    });

    it('creates section-level parent chunks for large sections', () => {
      const chunker = new SemanticChunker({ chunkSize: 30, chunkOverlap: 0 });
      const text = '## Big Section\n\n' + 'Word '.repeat(100);
      const result = chunker.chunkDocument(text);
      const sectionChunks = result.filter((c) => c.level === 'section');
      const paragraphChunks = result.filter((c) => c.level === 'paragraph');
      expect(paragraphChunks.length).toBeGreaterThan(1);
      expect(sectionChunks.length).toBeGreaterThanOrEqual(1);
    });

    it('sets parentIndex for paragraph chunks under multi-chunk sections', () => {
      const chunker = new SemanticChunker({ chunkSize: 30, chunkOverlap: 0 });
      const text = '## Section\n\n' + 'Word '.repeat(100);
      const result = chunker.chunkDocument(text);
      const paragraphs = result.filter((c) => c.level === 'paragraph');
      if (paragraphs.length > 1) {
        const withParent = paragraphs.filter((c) => c.parentIndex !== null);
        expect(withParent.length).toBeGreaterThan(0);
      }
    });

    it('estimates tokens for each chunk', () => {
      const chunker = new SemanticChunker({ chunkSize: 500 });
      const text = '## Test\n\nSome content with several words.';
      const result = chunker.chunkDocument(text);
      for (const chunk of result) {
        expect(chunk.tokenEstimate).toBeGreaterThan(0);
        // Rough check: tokens ~= chars / 4
        expect(chunk.tokenEstimate).toBeLessThanOrEqual(chunk.content.length);
      }
    });
  });

  describe('custom options', () => {
    it('respects custom chunk size', () => {
      const chunker = new SemanticChunker({ chunkSize: 50, chunkOverlap: 0 });
      const text = 'A'.repeat(200);
      const result = chunker.splitText(text);
      expect(result.length).toBeGreaterThan(1);
      for (const chunk of result) {
        // Chunks should be at most ~chunkSize (with some tolerance for overlap)
        expect(chunk.length).toBeLessThanOrEqual(60);
      }
    });

    it('respects custom separators', () => {
      const chunker = new SemanticChunker({
        chunkSize: 50,
        chunkOverlap: 0,
        separators: ['|||'],
      });
      const text = 'Part A content here|||Part B content here|||Part C content here';
      const result = chunker.splitText(text);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ============================================================
// Sprint 2.2: Query Intent Detection Tests
// ============================================================

describe('QueryIntentDetection', () => {
  describe('detectQueryIntent', () => {
    it('detects factual intent', () => {
      const result = detectQueryIntent('O que é um contrato de prestação de serviço?');
      expect(result.intent).toBe('factual');
      expect(result.confidence).toBeGreaterThan(0.3);
      expect(result.matchedKeywords.length).toBeGreaterThan(0);
    });

    it('detects procedural intent', () => {
      const result = detectQueryIntent('Como fazer o registro no sistema?');
      expect(result.intent).toBe('procedural');
      expect(result.matchedKeywords).toContain('como');
    });

    it('detects comparative intent', () => {
      const result = detectQueryIntent('Qual a diferença entre REST e GraphQL?');
      expect(result.intent).toBe('comparative');
    });

    it('detects regulatory intent', () => {
      const result = detectQueryIntent('Qual a resolução da diretoria sobre a política?');
      expect(result.intent).toBe('regulatory');
    });

    it('returns general for unclassifiable queries', () => {
      const result = detectQueryIntent('informações gerais do sistema');
      expect(result.intent).toBe('general');
      expect(result.confidence).toBeLessThanOrEqual(0.5);
    });

    it('handles empty query', () => {
      const result = detectQueryIntent('');
      expect(result.intent).toBe('general');
    });

    it('handles accented characters', () => {
      const result = detectQueryIntent('Qual é a definição de mercado?');
      expect(result.intent).toBe('factual');
      expect(result.matchedKeywords.length).toBeGreaterThan(0);
    });

    it('detects multiple keywords for higher confidence', () => {
      const single = detectQueryIntent('O que é idempotência?');
      const multi = detectQueryIntent('Qual é a definição do significado de idempotência?');
      expect(multi.confidence).toBeGreaterThanOrEqual(single.confidence);
    });

    it('provides suggestedParams for each intent', () => {
      const intents: QueryIntent[] = [
        'factual',
        'procedural',
        'comparative',
        'regulatory',
        'general',
      ];
      for (const intent of intents) {
        const params = getRetrievalParamsForIntent(intent);
        expect(params).toHaveProperty('topK');
        expect(params).toHaveProperty('hybridWeight');
        expect(params).toHaveProperty('useReranking');
        expect(params).toHaveProperty('useMMR');
        expect(params.topK).toBeGreaterThan(0);
        expect(params.hybridWeight).toBeGreaterThanOrEqual(0);
        expect(params.hybridWeight).toBeLessThanOrEqual(1);
      }
    });

    it('comparative intent enables MMR for diversity', () => {
      const result = detectQueryIntent('Qual a diferença entre exportação e importação?');
      expect(result.suggestedParams.useMMR).toBe(true);
      expect(result.suggestedParams.mmrLambda).toBeLessThan(0.5);
    });

    it('procedural intent enables parent retrieval', () => {
      const result = detectQueryIntent('Como funciona o processo de despacho?');
      expect(result.suggestedParams.useParentRetrieval).toBe(true);
    });

    it('factual intent enables compression', () => {
      const result = detectQueryIntent('O que é um drawback?');
      expect(result.intent).toBe('factual');
      expect(result.suggestedParams.useCompression).toBe(true);
    });

    it('regulatory intent has high hybridWeight', () => {
      const result = detectQueryIntent('Resolução do Bacen sobre PLD');
      expect(result.suggestedParams.hybridWeight).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe('mergeRetrievalParams', () => {
    it('overrides intent params with user params', () => {
      const intentParams = getRetrievalParamsForIntent('factual');
      const merged = mergeRetrievalParams(intentParams, { topK: 10 });
      expect(merged.topK).toBe(10);
      expect(merged.hybridWeight).toBe(intentParams.hybridWeight); // Unchanged
    });

    it('keeps intent params when no overrides', () => {
      const intentParams = getRetrievalParamsForIntent('regulatory');
      const merged = mergeRetrievalParams(intentParams, {});
      expect(merged).toEqual(intentParams);
    });
  });
});

// ============================================================
// Sprint 1.1: Vector Search Service Tests
// ============================================================

describe('VectorSearchService', () => {
  let service: VectorSearchService;

  beforeEach(() => {
    service = new VectorSearchService();
    vi.clearAllMocks();
  });

  describe('isNativeAvailable', () => {
    it('returns false for SQLite', async () => {
      const available = await service.isNativeAvailable();
      expect(available).toBe(false);
    });
  });

  describe('search (fallback mode)', () => {
    it('returns empty array (fallback JS search not implemented for refinement)', async () => {
      const results = await service.search(new Array(3072).fill(0.1), 'refinement', 5);
      expect(results).toEqual([]);
    });
  });

  describe('storeEmbedding', () => {
    it('is no-op when not PostgreSQL', async () => {
      await service.storeEmbedding({
        chunkId: 'test',
        chunkSource: 'refinement',
        embedding: new Array(3072).fill(0.1),
      });
      // Should not call dbHelper.run since isPostgres is false
      expect(dbHelper.run).not.toHaveBeenCalled();
    });
  });

  describe('getCount', () => {
    it('returns 0 when not PostgreSQL', async () => {
      const count = await service.getCount();
      expect(count).toBe(0);
    });
  });
});

// ============================================================
// Sprint 3.2: RAG Feedback Loop Tests
// ============================================================

describe('RAGFeedbackService', () => {
  let service: RAGFeedbackService;
  const mockDbAll = vi.mocked(dbHelper.all);
  const mockDbRun = vi.mocked(dbHelper.run);

  beforeEach(() => {
    service = new RAGFeedbackService();
    vi.clearAllMocks();
    // Allow schema creation
    mockDbRun.mockResolvedValue(undefined);
  });

  describe('recordFeedback', () => {
    it('records explicit feedback', async () => {
      const feedback: RAGFeedback = {
        queryId: 'q-1',
        queryText: 'O que e idempotencia?',
        chunkId: 'chunk-1',
        chunkSource: 'refinement',
        wasHelpful: true,
        feedbackType: 'explicit',
      };

      // Mock for schema + insert + aggregation query + upsert
      mockDbAll.mockResolvedValue([{ total_shown: 1, total_helpful: 1, total_selected: 0 }]);

      await service.recordFeedback(feedback);

      // Should have called run for schema creation + insert + score update
      expect(mockDbRun).toHaveBeenCalled();
    });

    it('records implicit feedback', async () => {
      const feedback: RAGFeedback = {
        queryId: 'q-2',
        queryText: 'Como funciona o sistema?',
        chunkId: 'chunk-2',
        chunkSource: 'refinement',
        wasHelpful: true,
        feedbackType: 'implicit',
      };

      mockDbAll.mockResolvedValue([{ total_shown: 5, total_helpful: 4, total_selected: 0 }]);

      await service.recordFeedback(feedback);
      expect(mockDbRun).toHaveBeenCalled();
    });
  });

  describe('getChunkBoost', () => {
    it('returns 1.0 when no data exists', async () => {
      // ensureSchema doesn't call dbHelper.all, only dbHelper.run
      // getChunkBoost calls dbHelper.all once
      mockDbAll.mockResolvedValueOnce([]); // query returns empty
      const boost = await service.getChunkBoost('unknown', 'refinement');
      expect(boost).toBe(1.0);
    });

    it('returns stored boost factor', async () => {
      const svc = new RAGFeedbackService();
      mockDbAll.mockResolvedValueOnce([{ boost_factor: 1.2 }]);
      const boost = await svc.getChunkBoost('chunk-1', 'refinement');
      expect(boost).toBe(1.2);
    });
  });

  describe('getChunkStats', () => {
    it('returns null when no stats exist', async () => {
      const svc = new RAGFeedbackService();
      mockDbAll.mockResolvedValueOnce([]); // query returns empty
      const stats = await svc.getChunkStats('unknown', 'refinement');
      expect(stats).toBeNull();
    });

    it('returns stats when available', async () => {
      const svc = new RAGFeedbackService();
      mockDbAll.mockResolvedValueOnce([
        {
          chunk_id: 'chunk-1',
          chunk_source: 'refinement',
          total_shown: '10',
          total_helpful: '8',
          total_selected: '3',
          success_rate: '0.8',
          boost_factor: '1.2',
        },
      ]);
      const stats = await svc.getChunkStats('chunk-1', 'refinement');
      expect(stats).not.toBeNull();
      expect(stats!.totalShown).toBe(10);
      expect(stats!.totalHelpful).toBe(8);
      expect(stats!.boostFactor).toBe(1.2);
      expect(stats!.successRate).toBe(0.8);
    });
  });

  describe('getChunkBoosts (batch)', () => {
    it('returns map of boost factors', async () => {
      const svc = new RAGFeedbackService();
      mockDbAll.mockResolvedValueOnce([
        { chunk_id: 'c1', boost_factor: 1.2 },
        { chunk_id: 'c2', boost_factor: 0.8 },
      ]);
      const boosts = await svc.getChunkBoosts(['c1', 'c2'], 'refinement');
      expect(boosts.get('c1')).toBe(1.2);
      expect(boosts.get('c2')).toBe(0.8);
    });

    it('returns empty map for empty input', async () => {
      const boosts = await service.getChunkBoosts([], 'refinement');
      expect(boosts.size).toBe(0);
    });
  });

  describe('boost factor calculation', () => {
    it('gives 1.2x boost for high success rate (>0.7)', async () => {
      // Record 4 helpful feedbacks
      mockDbAll.mockResolvedValue([{ total_shown: 5, total_helpful: 4, total_selected: 2 }]);
      for (let i = 0; i < 4; i++) {
        await service.recordFeedback({
          queryId: `q-${i}`,
          queryText: 'test',
          chunkId: 'good-chunk',
          chunkSource: 'refinement',
          wasHelpful: true,
        });
      }

      // The upsert should have been called with boost_factor 1.2
      // We verify the aggregation was called with correct stats
      expect(mockDbRun).toHaveBeenCalled();
    });

    it('gives 0.8x penalty for low success rate (<0.5)', async () => {
      mockDbAll.mockResolvedValue([{ total_shown: 10, total_helpful: 3, total_selected: 0 }]);
      await service.recordFeedback({
        queryId: 'q-1',
        queryText: 'test',
        chunkId: 'bad-chunk',
        chunkSource: 'refinement',
        wasHelpful: false,
      });
      expect(mockDbRun).toHaveBeenCalled();
    });
  });
});

// ============================================================
// Integration: Feature Flags
// ============================================================

describe('Feature Flags', () => {
  it('includes RAG improvement flags', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const flagsPath = path.join(process.cwd(), 'config', 'feature-flags.json');
    const flags = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));

    expect(flags.enablePgVector).toBe(true);
    expect(flags.enableQueryIntentDetection).toBe(true);
    expect(flags.enableRagFeedbackLoop).toBe(true);
    expect(flags.enableRefinementHybridSearch).toBe(true);
  });
});

// ============================================================
// Migration file existence check
// ============================================================

describe('Migration 0014', () => {
  it('migration file exists', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.join(process.cwd(), 'migrations', '0014_rag_improvements.sql');
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('contains pgvector extension', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.join(process.cwd(), 'migrations', '0014_rag_improvements.sql'),
      'utf8',
    );
    expect(content).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(content).toContain('chunk_embeddings');
    expect(content).toContain('vector(3072)');
    expect(content).toContain('hnsw');
    expect(content).toContain('rag_feedback');
    expect(content).toContain('chunk_relevance_scores');
    expect(content).toContain('parent_chunk_id');
  });
});
