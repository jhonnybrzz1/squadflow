import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateIdempotencySchema,
  registerIdempotencyKey,
  recordSuccessfulDialect,
  removeIdempotencyKey,
} from '../server/workers/document-worker-utils';

// Mock dependencies
vi.mock('../server/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve({})),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve({})),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve({})),
    })),
  },
  dbHelper: {
    isPostgres: false,
    all: vi.fn(),
  },
}));

vi.mock('../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('document-worker-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateIdempotencySchema', () => {
    it('validates schema successfully for SQLite', async () => {
      const { dbHelper } = await import('../server/db');
      (dbHelper.all as any).mockResolvedValue([{ name: 'last_succeeded_dialect' }]);

      await expect(validateIdempotencySchema()).resolves.not.toThrow();
    });

    it('throws error when column not found', async () => {
      const { dbHelper } = await import('../server/db');
      (dbHelper.all as any).mockResolvedValue([{ name: 'other_column' }]);

      await expect(validateIdempotencySchema()).rejects.toThrow('SchemaIntegrityError');
    });
  });

  describe('registerIdempotencyKey', () => {
    it('registers idempotency key successfully', async () => {
      await expect(registerIdempotencyKey('test_key')).resolves.not.toThrow();
    });

    it('throws DUPLICATE_KEY error on duplicate', async () => {
      const { db } = await import('../server/db');
      const error = new Error('UNIQUE constraint failed');
      (error as any).code = 'SQLITE_CONSTRAINT_UNIQUE';
      (db.insert as any).mockReturnValueOnce({
        values: vi.fn(() => Promise.reject(error)),
      });

      await expect(registerIdempotencyKey('test_key')).rejects.toThrow('DUPLICATE_KEY');
    });
  });

  describe('recordSuccessfulDialect', () => {
    it('records successful dialect', async () => {
      await expect(recordSuccessfulDialect('test_key')).resolves.not.toThrow();
    });

    it('handles schema drift gracefully', async () => {
      const { db } = await import('../server/db');
      const error = new Error('no column named last_succeeded_dialect');
      (db.update as any).mockReturnValueOnce({
        set: vi.fn(() => ({
          where: vi.fn(() => Promise.reject(error)),
        })),
      });

      await expect(recordSuccessfulDialect('test_key')).rejects.toThrow('Schema desatualizado');
    });
  });

  describe('removeIdempotencyKey', () => {
    it('removes idempotency key successfully', async () => {
      await expect(removeIdempotencyKey('test_key')).resolves.not.toThrow();
    });

    it('ignores deletion errors silently', async () => {
      const { db } = await import('../server/db');
      (db.delete as any).mockReturnValueOnce({
        where: vi.fn(() => Promise.reject(new Error('Deletion failed'))),
      });

      await expect(removeIdempotencyKey('test_key')).resolves.not.toThrow();
    });
  });
});
