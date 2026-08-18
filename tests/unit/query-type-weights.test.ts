import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mocks = vi.hoisted(() => ({
  dbAll: vi.fn(),
  dbRun: vi.fn(),
}));

vi.mock('../../server/db', () => ({
  db: {},
  isPostgres: false,
}));

vi.mock('../../server/utils/db-utils', () => ({
  dbAll: mocks.dbAll,
  dbRun: mocks.dbRun,
}));

import {
  QueryTypeWeightsService,
  DEFAULT_HYBRID_WEIGHTS,
} from '../../server/services/query-type-weights';
import { logger } from '../../server/utils/logger';

describe('A-1: QueryTypeWeightsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbAll.mockReset();
    mocks.dbRun.mockReset();
  });

  it('retorna pesos do seed para queryType conhecido (factual)', async () => {
    mocks.dbAll.mockResolvedValueOnce([
      { query_type: 'factual', keyword_weight: 0.7, semantic_weight: 0.3 },
    ]);

    const service = new QueryTypeWeightsService();
    const result = await service.getWeights('factual');

    expect(result.keywordWeight).toBe(0.7);
    expect(result.semanticWeight).toBe(0.3);
    expect(result.matched).toBe(true);
  });

  it('retorna pesos do seed para queryType conhecido (contextual)', async () => {
    mocks.dbAll.mockResolvedValueOnce([
      { query_type: 'contextual', keyword_weight: 0.3, semantic_weight: 0.7 },
    ]);

    const service = new QueryTypeWeightsService();
    const result = await service.getWeights('contextual');

    expect(result.keywordWeight).toBe(0.3);
    expect(result.semanticWeight).toBe(0.7);
    expect(result.matched).toBe(true);
  });

  it('falha silencioso para queryType ausente (default 0.5/0.5)', async () => {
    mocks.dbAll.mockResolvedValueOnce([]);

    const service = new QueryTypeWeightsService();
    const result = await service.getWeights(undefined);

    expect(result.keywordWeight).toBe(0.5);
    expect(result.semanticWeight).toBe(0.5);
    expect(result.matched).toBe(false);
  });

  it('falha silencioso para queryType desconhecido com warning', async () => {
    mocks.dbAll.mockResolvedValueOnce([]);

    const service = new QueryTypeWeightsService();
    const result = await service.getWeights('inexistente');

    expect(result.keywordWeight).toBe(DEFAULT_HYBRID_WEIGHTS.keywordWeight);
    expect(result.semanticWeight).toBe(DEFAULT_HYBRID_WEIGHTS.semanticWeight);
    expect(result.matched).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'A-1: queryType desconhecido, fallback para 0.5/0.5',
      expect.any(Object),
    );
  });

  it('normaliza queryType para lowercase e trim', async () => {
    mocks.dbAll.mockResolvedValueOnce([
      { query_type: 'procedural', keyword_weight: 0.6, semantic_weight: 0.4 },
    ]);

    const service = new QueryTypeWeightsService();
    const result = await service.getWeights('  PROCEDURAL  ');

    expect(result.keywordWeight).toBe(0.6);
    expect(result.semanticWeight).toBe(0.4);
  });

  it('garante schema e seed via dbRun', async () => {
    mocks.dbRun.mockResolvedValue(undefined);

    const service = new QueryTypeWeightsService();
    await service.ensureSchemaAndSeed();

    expect(mocks.dbRun).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('A-1: query_type_weights schema e seed garantidos');
  });
});
