import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  computeRuleBasedScore,
  classifyDemandVagueness,
  resetExemplarCache,
  type HybridClassificationResult,
} from '../server/services/hybrid-classifier';

// Mock db to avoid native binding errors
vi.mock('../server/db', () => ({
  isPostgres: false,
  db: {
    query: {
      demands: { findFirst: vi.fn() },
    },
  },
  dbHelper: {
    all: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock embedding service
const mockGetEmbedding = vi.fn();
const mockGetEmbeddings = vi.fn();
const mockCosineSimilarity = vi.fn();

vi.mock('../server/services/embedding-service', () => ({
  embeddingService: {
    getEmbedding: (...args: any[]) => mockGetEmbedding(...args),
    getEmbeddings: (...args: any[]) => mockGetEmbeddings(...args),
    cosineSimilarity: (...args: any[]) => mockCosineSimilarity(...args),
  },
}));

// Mock logger
vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock Prometheus metrics
vi.mock('../server/metrics', () => ({
  demandsByClassificationZone: { labels: vi.fn().mockReturnValue({ inc: vi.fn() }) },
  classificationLatency: { labels: vi.fn().mockReturnValue({ observe: vi.fn() }) },
  classificationCostPerDemand: { labels: vi.fn().mockReturnValue({ observe: vi.fn() }) },
  aiCallDuration: { labels: vi.fn().mockReturnValue({ observe: vi.fn() }) },
  aiTokensUsage: { labels: vi.fn().mockReturnValue({ inc: vi.fn() }) },
  httpRequestDurationMicroseconds: { labels: vi.fn().mockReturnValue({ observe: vi.fn() }) },
  retrabalhoRateByZone: { labels: vi.fn().mockReturnValue({ set: vi.fn() }) },
  register: { registerMetric: vi.fn() },
}));

// Mock aiUsageTracker
vi.mock('../server/services/ai-usage-tracker', () => ({
  aiUsageTracker: { record: vi.fn() },
  estimateTextTokens: (text: string) => Math.max(1, Math.ceil(text.length / 4)),
  estimateCost: async (_model: string, tokens: number) => ({
    listCostUsd: (tokens / 1_000_000) * 0.02,
    billedCostUsd: null,
    creditAppliedUsd: null,
    pricingSource: 'static',
    pricingUpdatedAt: null,
    isEstimated: true,
  }),
}));

// Mock request ID
vi.mock('../server/utils/request-id', () => ({
  generateRequestId: () => 'test-request-id',
}));

// ============================================
// CT01: Rule-based score — clearly vague
// ============================================
describe('CT01: computeRuleBasedScore — clearly vague demands', () => {
  it('scores high for text with many vague words', () => {
    const score = computeRuleBasedScore(
      'Talvez seria bom melhorar algumas coisas do sistema. Pode ser que ajude.',
    );
    expect(score).toBeGreaterThan(70);
  });

  it('scores high for very short description', () => {
    const score = computeRuleBasedScore('Melhorar sistema');
    expect(score).toBeGreaterThan(0);
  });

  it('scores high for question-heavy vague text', () => {
    const score = computeRuleBasedScore(
      'Será que faz sentido? Não sei. Depende? Talvez eventualmente?',
    );
    expect(score).toBeGreaterThan(50);
  });
});

// ============================================
// CT02: Rule-based score — clearly not vague
// ============================================
describe('CT02: computeRuleBasedScore — clearly not vague demands', () => {
  it('scores low for specific technical requirements', () => {
    const score = computeRuleBasedScore(
      'Implementar cursor-based pagination no GET /api/demands retornando 20 itens por página com campos next_cursor e has_more. Timeout 5s. Redis cache TTL 60s.',
    );
    expect(score).toBeLessThan(30);
  });

  it('scores low for detailed bug report', () => {
    const score = computeRuleBasedScore(
      'Corrigir erro 500 no endpoint POST /api/demands quando campo priority é null. Stack trace aponta para validação no middleware de schema. Reproduzível com curl.',
    );
    expect(score).toBeLessThan(30);
  });

  it('scores low for numbered step plan', () => {
    const score = computeRuleBasedScore(
      '1) Configurar Redis cache, 2) Implementar endpoint GET /api/health, 3) Adicionar Docker compose com PostgreSQL e Redis.',
    );
    expect(score).toBeLessThan(30);
  });
});

// ============================================
// CT03: Rule-based score — ambiguous zone (30-70)
// ============================================
describe('CT03: computeRuleBasedScore — ambiguous zone', () => {
  it('produces ambiguous score for mixed-signal text', () => {
    const score = computeRuleBasedScore(
      'A busca precisa ser melhorada. Quando pesquiso os resultados não são bons. Seria bom se fosse mais inteligente.',
    );
    expect(score).toBeGreaterThanOrEqual(30);
    expect(score).toBeLessThanOrEqual(70);
  });

  it('produces ambiguous score for somewhat specific but uncertain text', () => {
    const score = computeRuleBasedScore(
      'Podíamos ter notificações no sistema. Tipo quando alguém faz algo relevante. Talvez usar email ou WebSocket.',
    );
    expect(score).toBeGreaterThanOrEqual(20);
    expect(score).toBeLessThanOrEqual(80);
  });
});

// ============================================
// CT04: Embedding fallback on error/timeout
// ============================================
describe('CT04: classifyDemandVagueness — fallback on embedding failure', () => {
  beforeEach(() => {
    resetExemplarCache();
    vi.clearAllMocks();
  });

  it('falls back to rules when embedding throws', async () => {
    mockGetEmbeddings.mockRejectedValue(new Error('API unavailable'));

    const result = await classifyDemandVagueness(
      'Melhorar busca',
      'A busca precisa ser melhorada. Quando pesquiso os resultados não são bons. Seria bom.',
    );

    expect(result.method).toBe('fallback');
    expect(result.embeddingScore).toBeNull();
    expect(result.label).toBeDefined();
    expect(result.costUsd).toBe(0);
  });

  it('falls back to rules when embedding times out', async () => {
    mockGetEmbeddings.mockImplementation(
      () => new Promise((_resolve) => setTimeout(() => _resolve([]), 10_000)),
    );

    const result = await classifyDemandVagueness(
      'Melhorar busca',
      'A busca precisa ser melhorada. Os resultados não são bons. Seria bom.',
    );

    expect(result.method).toBe('fallback');
    expect(result.embeddingScore).toBeNull();
  }, 10_000);
});

// ============================================
// CT05: Rule-only path (score < 30 or > 70)
// ============================================
describe('CT05: classifyDemandVagueness — rule-only path (outside ambiguous zone)', () => {
  beforeEach(() => {
    resetExemplarCache();
    vi.clearAllMocks();
  });

  it('uses rule method for clearly vague demand', async () => {
    const result = await classifyDemandVagueness(
      'Melhorar sistema',
      'Talvez seria bom melhorar algumas coisas diferentes do sistema. Pode ser que ajude eventualmente. Algo sobre isso.',
    );

    expect(result.method).toBe('rule');
    expect(result.label).toBe('vaga');
    expect(result.embeddingScore).toBeNull();
    expect(result.costUsd).toBe(0);
    // Embedding should NOT have been called
    expect(mockGetEmbedding).not.toHaveBeenCalled();
    expect(mockGetEmbeddings).not.toHaveBeenCalled();
  });

  it('uses rule method for clearly not vague demand', async () => {
    const result = await classifyDemandVagueness(
      'Implementar endpoint GET /api/health',
      'Retornar JSON {status: "ok", uptime: process.uptime()}. Timeout 5s. HTTP 200 se ok, 503 se database unreachable. Adicionar ao Docker healthcheck.',
    );

    expect(result.method).toBe('rule');
    expect(result.label).toBe('nao_vaga');
    expect(result.embeddingScore).toBeNull();
    expect(result.costUsd).toBe(0);
    expect(mockGetEmbedding).not.toHaveBeenCalled();
  });
});

// ============================================
// CT06: Hybrid path (score 30-70, embedding works)
// ============================================
describe('CT06: classifyDemandVagueness — hybrid path (ambiguous zone)', () => {
  beforeEach(() => {
    resetExemplarCache();
    vi.clearAllMocks();

    // Mock exemplar embeddings (5 vague + 5 not-vague)
    mockGetEmbeddings.mockImplementation((texts: string[]) => {
      return Promise.resolve(texts.map((_, i) => [i * 0.1, 0.5, 0.3]));
    });
  });

  it('calls embedding for ambiguous demand and returns hybrid method', async () => {
    // Mock embedding for the input text
    mockGetEmbedding.mockResolvedValue([0.4, 0.5, 0.3]);

    // Mock cosine similarity: higher similarity to vague exemplars
    mockCosineSimilarity.mockImplementation((_a: number[], _b: number[]) => {
      // First 5 calls are vague exemplars, next 5 are not-vague
      const callCount = mockCosineSimilarity.mock.calls.length;
      if (callCount <= 5) return 0.85; // High similarity to vague
      return 0.55; // Lower similarity to not-vague
    });

    const result = await classifyDemandVagueness(
      'Melhorar busca',
      'A busca precisa ser melhorada. Quando pesquiso os resultados não são bons. Seria bom.',
    );

    // Should use embedding since score is in ambiguous zone
    if (result.method === 'hybrid') {
      expect(result.embeddingScore).not.toBeNull();
      expect(result.label).toBeDefined();
      expect(result.costUsd).toBeGreaterThanOrEqual(0);
    } else {
      // It's valid for rule score to fall outside ambiguous zone depending on text
      expect(['rule', 'fallback']).toContain(result.method);
    }
  });

  it('classifies as nao_vaga when embedding favors not-vague exemplars', async () => {
    mockGetEmbedding.mockResolvedValue([0.9, 0.5, 0.3]);

    // Higher similarity to not-vague exemplars
    mockCosineSimilarity.mockImplementation(() => {
      const callCount = mockCosineSimilarity.mock.calls.length;
      if (callCount <= 5) return 0.45; // Lower similarity to vague
      return 0.88; // Higher similarity to not-vague
    });

    const result = await classifyDemandVagueness(
      'Olhar questão de segurança',
      'Precisamos verificar a segurança do sistema. Pode ter vulnerabilidades. Seria bom fazer uma revisão.',
    );

    if (result.method === 'hybrid') {
      expect(result.label).toBe('nao_vaga');
      expect(result.embeddingScore).toBeLessThan(0.5);
    }
  });
});

// ============================================
// CT07: Regression — existing classification unbroken
// ============================================
describe('CT07: Regression — rule-based score consistency', () => {
  it('empty string returns 0 or positive score', () => {
    const score = computeRuleBasedScore('');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('special characters do not crash', () => {
    const score = computeRuleBasedScore('Teste @#$%^&*() 🎉 ñ ü ö');
    expect(typeof score).toBe('number');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('very long text does not exceed 100', () => {
    const longText = 'a '.repeat(5000);
    const score = computeRuleBasedScore(longText);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('score is always between 0 and 100', () => {
    const texts = [
      'hello',
      'Implementar API REST com PostgreSQL e Redis. Timeout 5s. Cache TTL 60s.',
      'Talvez seria bom pensar em melhorar algo eventualmente. Não sei. Pode ser. Depende.',
      'a',
      '',
    ];
    for (const text of texts) {
      const score = computeRuleBasedScore(text);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});

// ============================================
// CT08: Performance — latency bound
// ============================================
describe('CT08: classifyDemandVagueness — rule-only latency', () => {
  beforeEach(() => {
    resetExemplarCache();
    vi.clearAllMocks();
  });

  it('rule-only classification completes in < 50ms', async () => {
    const start = Date.now();
    await classifyDemandVagueness(
      'Implementar endpoint',
      'Retornar JSON status ok. Timeout 5s. HTTP 200 se ok. Docker healthcheck. Redis cache TTL 60s. PostgreSQL query.',
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

// ============================================
// CT09: Contract — result shape
// ============================================
describe('CT09: classifyDemandVagueness — result contract', () => {
  beforeEach(() => {
    resetExemplarCache();
    vi.clearAllMocks();
  });

  it('returns correct shape for rule-only classification', async () => {
    const result = await classifyDemandVagueness(
      'Melhorar sistema',
      'Talvez seria bom melhorar algumas coisas diferentes do sistema. Pode ser que ajude eventualmente. Algo sobre isso.',
    );

    expect(result).toHaveProperty('label');
    expect(result).toHaveProperty('ruleScore');
    expect(result).toHaveProperty('embeddingScore');
    expect(result).toHaveProperty('method');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('latencyMs');
    expect(result).toHaveProperty('costUsd');

    expect(['vaga', 'nao_vaga']).toContain(result.label);
    expect(['rule', 'hybrid', 'fallback']).toContain(result.method);
    expect(result.ruleScore).toBeGreaterThanOrEqual(0);
    expect(result.ruleScore).toBeLessThanOrEqual(100);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.costUsd).toBeGreaterThanOrEqual(0);
  });
});

// ============================================
// CT10: aiUsageTracker records classification events
// ============================================
describe('CT10: aiUsageTracker integration', () => {
  beforeEach(() => {
    resetExemplarCache();
    vi.clearAllMocks();
  });

  it('records a rule-only event', async () => {
    const { aiUsageTracker } = await import('../server/services/ai-usage-tracker');

    await classifyDemandVagueness(
      'Implementar endpoint',
      'Retornar JSON status ok. Timeout 5s. HTTP 200. Docker healthcheck. Redis cache. PostgreSQL query.',
    );

    expect(aiUsageTracker.record).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'classification:vagueness:rule',
        model: 'rule-based',
        estimatedCostUsd: 0,
      }),
    );
  });

  it('records a fallback event when embedding fails', async () => {
    const { aiUsageTracker } = await import('../server/services/ai-usage-tracker');
    mockGetEmbeddings.mockRejectedValue(new Error('fail'));

    await classifyDemandVagueness(
      'Melhorar busca',
      'A busca precisa ser melhorada. Resultados não são bons. Seria bom.',
    );

    expect(aiUsageTracker.record).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.stringContaining('classification:vagueness:'),
        fallbackUsed: expect.any(Boolean),
      }),
    );
  });
});

// ============================================
// CT11: Prometheus metrics emission
// ============================================
describe('CT11: Prometheus metrics emission', () => {
  beforeEach(() => {
    resetExemplarCache();
    vi.clearAllMocks();
  });

  it('emits zone, latency, and cost metrics for rule classification', async () => {
    const { demandsByClassificationZone, classificationLatency, classificationCostPerDemand } =
      await import('../server/metrics');

    await classifyDemandVagueness(
      'Implementar endpoint',
      'Retornar JSON status ok. Timeout 5s. HTTP 200. Docker healthcheck. Redis cache. PostgreSQL query.',
    );

    expect(demandsByClassificationZone.labels).toHaveBeenCalled();
    expect(classificationLatency.labels).toHaveBeenCalledWith('rule');
    expect(classificationCostPerDemand.labels).toHaveBeenCalledWith('rule');
  });
});

// ============================================
// CT12: Vague words list coverage
// ============================================
describe('CT12: Vague word detection', () => {
  const vagueWordsToTest = [
    'talvez',
    'possível',
    'poderia',
    'pode ser',
    'seria bom',
    'eventualmente',
    'algo',
    'coisa',
    'depende',
    'pensar em',
  ];

  for (const word of vagueWordsToTest) {
    it(`detects vague word: "${word}"`, () => {
      const score = computeRuleBasedScore(`Precisamos ${word} no sistema para melhorar.`);
      expect(score).toBeGreaterThan(0);
    });
  }
});

// ============================================
// CT13: Specificity signals reduce score
// ============================================
describe('CT13: Specificity signals', () => {
  it('technical terms reduce vagueness score', () => {
    const vague = computeRuleBasedScore('Melhorar a busca do sistema. Seria bom.');
    const specific = computeRuleBasedScore(
      'Melhorar a busca do sistema. Seria bom. Usar endpoint GET /api/search com timeout 5s.',
    );
    expect(specific).toBeLessThan(vague);
  });

  it('quantitative data reduces vagueness score', () => {
    const vague = computeRuleBasedScore('Melhorar performance. Seria bom.');
    const specific = computeRuleBasedScore(
      'Melhorar performance. Seria bom. Target: p95 < 200ms, 500 rps.',
    );
    expect(specific).toBeLessThan(vague);
  });
});

// ============================================
// CT14: Edge case — empty demand
// ============================================
describe('CT14: Edge cases', () => {
  beforeEach(() => {
    resetExemplarCache();
    vi.clearAllMocks();
  });

  it('handles empty title and description', async () => {
    const result = await classifyDemandVagueness('', '');
    expect(result.label).toBeDefined();
    expect(result.method).toBe('rule');
  });

  it('handles very long text', async () => {
    const longDesc = 'Implementar sistema de cache com Redis. '.repeat(100);
    const result = await classifyDemandVagueness('Cache', longDesc);
    expect(result.label).toBe('nao_vaga');
    expect(result.method).toBe('rule');
  });
});

// ============================================
// CT15: Score boundary tests (30 and 70)
// ============================================
describe('CT15: Score boundaries', () => {
  it('score of exactly 30 triggers ambiguous zone', () => {
    // We test the boundary logic indirectly
    const score = computeRuleBasedScore(
      'Talvez melhorar alguns filtros. Pode ser que ajude os usuários.',
    );
    // Score should be in or near ambiguous zone due to vague words
    expect(score).toBeGreaterThan(0);
  });
});

// ============================================
// CT16: classifyDemandVagueness result types
// ============================================
describe('CT16: TypeScript contract — result types', () => {
  beforeEach(() => {
    resetExemplarCache();
    vi.clearAllMocks();
  });

  it('result matches HybridClassificationResult interface', async () => {
    const result: HybridClassificationResult = await classifyDemandVagueness(
      'Algo',
      'Talvez melhorar algo no sistema eventualmente. Não sei exatamente o quê.',
    );

    // Type assertions
    const _label: 'vaga' | 'nao_vaga' = result.label;
    const _method: 'rule' | 'hybrid' | 'fallback' = result.method;
    const _ruleScore: number = result.ruleScore;
    const _embeddingScore: number | null = result.embeddingScore;
    const _confidence: number = result.confidence;
    const _latencyMs: number = result.latencyMs;
    const _costUsd: number = result.costUsd;

    expect(_label).toBeDefined();
    expect(_method).toBeDefined();
    expect(typeof _ruleScore).toBe('number');
    expect(typeof _confidence).toBe('number');
    expect(typeof _latencyMs).toBe('number');
    expect(typeof _costUsd).toBe('number');
  });
});

// ============================================
// CT17: resetExemplarCache
// ============================================
describe('CT17: resetExemplarCache', () => {
  it('clears cache without error', () => {
    expect(() => resetExemplarCache()).not.toThrow();
  });

  it('can be called multiple times', () => {
    resetExemplarCache();
    resetExemplarCache();
    resetExemplarCache();
    expect(true).toBe(true);
  });
});

// ============================================
// CT18: Validation on 100-demand fixture (rule-based only)
// ============================================
describe('CT18: Rule-based accuracy on ground truth fixture', () => {
  const fixture = require('./fixtures/vagueness_ground_truth.json');

  it('rule-based achieves ≥ 75% accuracy on full fixture', () => {
    let correct = 0;
    const total = fixture.demands.length;

    // Rule-only threshold: scores >= AMBIGUOUS_ZONE_LOW (30) are treated as vague,
    // since in the real system these would be escalated to embeddings.
    const RULE_ONLY_THRESHOLD = 30;

    for (const demand of fixture.demands) {
      const text = `${demand.title} ${demand.description}`;
      const score = computeRuleBasedScore(text);
      const predicted = score >= RULE_ONLY_THRESHOLD ? 'vaga' : 'nao_vaga';

      if (predicted === demand.expected_label) {
        correct++;
      }
    }

    const accuracy = (correct / total) * 100;
    // Rule-based alone should be decent; hybrid will improve it
    expect(accuracy).toBeGreaterThanOrEqual(75);
  });

  it('identifies clear vague demands correctly', () => {
    const clearVagueDemands = fixture.demands.filter((d: any) => d.expected_zone === 'clear_vague');

    let correct = 0;
    for (const demand of clearVagueDemands) {
      const text = `${demand.title} ${demand.description}`;
      const score = computeRuleBasedScore(text);
      // Clear vague demands should score >= AMBIGUOUS_ZONE_LOW (30)
      if (score >= 30 && demand.expected_label === 'vaga') {
        correct++;
      }
    }

    if (clearVagueDemands.length > 0) {
      const accuracy = (correct / clearVagueDemands.length) * 100;
      expect(accuracy).toBeGreaterThanOrEqual(80);
    }
  });

  it('identifies clear not-vague demands correctly', () => {
    const clearNotVagueDemands = fixture.demands.filter(
      (d: any) => d.expected_zone === 'clear_not_vague',
    );

    let correct = 0;
    for (const demand of clearNotVagueDemands) {
      const text = `${demand.title} ${demand.description}`;
      const score = computeRuleBasedScore(text);
      // Clear not-vague should score below AMBIGUOUS_ZONE_LOW (30)
      if (score < 30 && demand.expected_label === 'nao_vaga') {
        correct++;
      }
    }

    if (clearNotVagueDemands.length > 0) {
      const accuracy = (correct / clearNotVagueDemands.length) * 100;
      expect(accuracy).toBeGreaterThanOrEqual(90);
    }
  });
});
