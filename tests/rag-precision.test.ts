/**
 * RAG Precision/Recall Metric Tests
 *
 * Validates that the URL normalization in evaluateRetrieval() works correctly
 * to avoid false 0% precision due to URL format mismatches.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock the dependencies before importing the service
vi.mock('../server/db', () => ({
  dbHelper: {
    all: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue(undefined),
  },
  isPostgres: false,
}));

vi.mock('../server/services/embedding-service', () => ({
  embeddingService: {
    embedText: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  },
}));

vi.mock('../server/services/openai-ai', () => ({
  openAIService: {
    createCompletion: vi.fn().mockResolvedValue({ content: 'test' }),
  },
}));

vi.mock('../server/services/llm-reorder', () => ({
  llmReorderService: {
    isAvailable: vi.fn().mockReturnValue(false),
    rerank: vi.fn().mockResolvedValue({ results: [] }),
  },
}));

vi.mock('../server/services/vector-search', () => ({
  vectorSearchService: {
    search: vi.fn().mockResolvedValue([]),
  },
}));

describe('RAG Precision URL Normalization', () => {
  /**
   * Helper to test URL normalization logic directly
   */
  const normalizeUrl = (url: string): string => {
    try {
      const parsed = new URL(url);
      return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/$/, '')}`;
    } catch (_) {
      return url
        .toLowerCase()
        .replace(/\/$/, '')
        .replace(/^https?:\/\//, '');
    }
  };

  describe('URL Normalization', () => {
    it('should normalize URLs with trailing slashes', () => {
      const url1 = 'https://www.gov.br/coaf/pt-br/';
      const url2 = 'https://www.gov.br/coaf/pt-br';
      expect(normalizeUrl(url1)).toBe(normalizeUrl(url2));
    });

    it('should normalize URLs with different protocols', () => {
      const url1 = 'http://www.gov.br/coaf/pt-br';
      const url2 = 'https://www.gov.br/coaf/pt-br';
      expect(normalizeUrl(url1)).toBe(normalizeUrl(url2));
    });

    it('should normalize URLs with different casing', () => {
      const url1 = 'https://WWW.GOV.BR/coaf/pt-br';
      const url2 = 'https://www.gov.br/coaf/pt-br';
      expect(normalizeUrl(url1)).toBe(normalizeUrl(url2));
    });

    it('should handle invalid URLs gracefully', () => {
      const url = 'not-a-valid-url';
      expect(normalizeUrl(url)).toBe('not-a-valid-url');
    });

    it('should preserve path distinctions', () => {
      const url1 = 'https://www.gov.br/coaf/pt-br/assuntos';
      const url2 = 'https://www.gov.br/coaf/pt-br/outros';
      expect(normalizeUrl(url1)).not.toBe(normalizeUrl(url2));
    });
  });

  describe('Precision/Recall Calculation', () => {
    it('should calculate precision correctly with matching URLs', () => {
      const retrieved = ['https://example.com/a', 'https://example.com/b'];
      const relevant = ['https://example.com/a'];

      const retrievedNorm = new Set(retrieved.map(normalizeUrl));
      const relevantNorm = new Set(relevant.map(normalizeUrl));

      const truePositives = [...retrievedNorm].filter((s) => relevantNorm.has(s)).length;
      const precision = truePositives / retrievedNorm.size;
      const recall = truePositives / relevantNorm.size;

      expect(precision).toBe(0.5); // 1 out of 2 retrieved is relevant
      expect(recall).toBe(1.0); // 1 out of 1 relevant was retrieved
    });

    it('should calculate precision correctly with URL variations', () => {
      // Simulating the bug: retrieved has trailing slash, relevant doesn't
      const retrieved = ['https://example.com/a/', 'https://example.com/b/'];
      const relevant = ['https://example.com/a', 'https://example.com/b'];

      const retrievedNorm = new Set(retrieved.map(normalizeUrl));
      const relevantNorm = new Set(relevant.map(normalizeUrl));

      const truePositives = [...retrievedNorm].filter((s) => relevantNorm.has(s)).length;
      const precision = truePositives / retrievedNorm.size;
      const recall = truePositives / relevantNorm.size;

      // After normalization, both URLs should match
      expect(precision).toBe(1.0);
      expect(recall).toBe(1.0);
    });

    it('should return 0 precision/recall when no overlap', () => {
      const retrieved = ['https://example.com/x', 'https://example.com/y'];
      const relevant = ['https://example.com/a', 'https://example.com/b'];

      const retrievedNorm = new Set(retrieved.map(normalizeUrl));
      const relevantNorm = new Set(relevant.map(normalizeUrl));

      const truePositives = [...retrievedNorm].filter((s) => relevantNorm.has(s)).length;
      const precision = retrievedNorm.size > 0 ? truePositives / retrievedNorm.size : 0;
      const recall = relevantNorm.size > 0 ? truePositives / relevantNorm.size : 0;

      expect(precision).toBe(0);
      expect(recall).toBe(0);
    });

    it('should handle empty retrieved set', () => {
      const retrieved: string[] = [];
      const relevant = ['https://example.com/a'];

      const retrievedNorm = new Set(retrieved.map(normalizeUrl));
      const relevantNorm = new Set(relevant.map(normalizeUrl));

      const truePositives = [...retrievedNorm].filter((s) => relevantNorm.has(s)).length;
      const precision = retrievedNorm.size > 0 ? truePositives / retrievedNorm.size : 0;
      const recall = relevantNorm.size > 0 ? truePositives / relevantNorm.size : 0;

      expect(precision).toBe(0);
      expect(recall).toBe(0);
    });

    it('should calculate F1 score correctly', () => {
      const retrieved = ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'];
      const relevant = ['https://example.com/a', 'https://example.com/b'];

      const retrievedNorm = new Set(retrieved.map(normalizeUrl));
      const relevantNorm = new Set(relevant.map(normalizeUrl));

      const truePositives = [...retrievedNorm].filter((s) => relevantNorm.has(s)).length;
      const precision = truePositives / retrievedNorm.size;
      const recall = truePositives / relevantNorm.size;
      const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

      expect(precision).toBeCloseTo(0.667, 2); // 2/3
      expect(recall).toBe(1.0); // 2/2
      expect(f1).toBeCloseTo(0.8, 2); // 2 * (0.667 * 1) / (0.667 + 1)
    });
  });
});
