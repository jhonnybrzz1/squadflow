import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';

const dbMock = vi.hoisted(() => ({
  run: vi.fn().mockResolvedValue(undefined),
  all: vi.fn().mockResolvedValue([]),
  get: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../server/db', () => ({
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
  dbHelper: dbMock,
}));

vi.mock('../../server/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const generateEmbedding = vi.hoisted(() => vi.fn());
const generateEmbeddings = vi.hoisted(() => vi.fn());

vi.mock('../../server/services/openai-ai', () => ({
  openAIService: {
    generateEmbedding,
    generateEmbeddings,
  },
}));

import { EmbeddingService } from '../../server/services/embedding-service';

const DEFAULT_EMBEDDING_MODEL = 'qwen/qwen3-embedding-8b';
const DEFAULT_EMBEDDING_DIMENSION = 3072;

function getNormalizedSql(query: SQL): string {
  const anyQuery = query as unknown as {
    queryChunks?: (string | { value: string[] | string } | number | boolean)[];
  };
  if (!anyQuery.queryChunks) return String(query);
  const parts = anyQuery.queryChunks.map((chunk) => {
    if (typeof chunk === 'string' || typeof chunk === 'number' || typeof chunk === 'boolean')
      return String(chunk);
    if (typeof chunk === 'object' && chunk && 'value' in chunk) {
      const v = chunk.value;
      return Array.isArray(v) ? v.join('') : String(v);
    }
    return '';
  });
  return parts.join('').replace(/\s+/g, ' ').trim();
}

describe('EmbeddingService cache key (#10147)', () => {
  let service: EmbeddingService;

  beforeEach(() => {
    vi.clearAllMocks();
    generateEmbedding.mockResolvedValue(new Array(DEFAULT_EMBEDDING_DIMENSION).fill(0.1));
    generateEmbeddings.mockImplementation((texts: string[]) =>
      Promise.resolve(texts.map(() => new Array(DEFAULT_EMBEDDING_DIMENSION).fill(0.1))),
    );
    service = new EmbeddingService();
  });

  it('getEmbedding includes model and dimensions in cache key', async () => {
    dbMock.all.mockResolvedValueOnce([]);
    await service.getEmbedding('same text');

    const [query] = vi.mocked(dbMock.all).mock.calls[0];
    const normalized = getNormalizedSql(query as SQL);
    expect(normalized).toContain('text_hash =');
    expect(normalized).toContain('model_id =');
    expect(normalized).toContain('dimensions =');
  });

  it('different models produce different hashes for the same text', async () => {
    const serviceAny = service as unknown as {
      hashText: (t: string, m: string, d: number) => string;
    };
    const hashA = serviceAny.hashText(
      'same text',
      DEFAULT_EMBEDDING_MODEL,
      DEFAULT_EMBEDDING_DIMENSION,
    );
    const hashB = serviceAny.hashText('same text', 'other/model', DEFAULT_EMBEDDING_DIMENSION);
    expect(hashA).not.toBe(hashB);
  });

  it('different dimensions produce different hashes for the same text', async () => {
    const serviceAny = service as unknown as {
      hashText: (t: string, m: string, d: number) => string;
    };
    const hashA = serviceAny.hashText(
      'same text',
      DEFAULT_EMBEDDING_MODEL,
      DEFAULT_EMBEDDING_DIMENSION,
    );
    const hashB = serviceAny.hashText('same text', DEFAULT_EMBEDDING_MODEL, 1536);
    expect(hashA).not.toBe(hashB);
  });

  it('getEmbeddings stores each entry with model+dimensions', async () => {
    dbMock.all.mockResolvedValue([]);
    await service.getEmbeddings(['text one', 'text two']);

    const insertCalls = vi.mocked(dbMock.run).mock.calls.filter((args) => {
      const sql = getNormalizedSql(args[0] as SQL);
      return sql.includes('INSERT OR REPLACE INTO embedding_cache');
    });
    expect(insertCalls.length).toBeGreaterThanOrEqual(1);
    const sql = getNormalizedSql(insertCalls[0][0] as SQL);
    expect(sql).toContain('model_id');
    expect(sql).toContain('dimensions');
  });
});
