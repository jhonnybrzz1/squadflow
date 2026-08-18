import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbHelperMock = vi.hoisted(() => ({
  run: vi.fn(),
  all: vi.fn(),
}));

vi.mock('../../server/db', () => ({
  dbHelper: dbHelperMock,
  isPostgres: false,
}));

import {
  VIBE_PLATFORM_CREATE_STATEMENTS,
  __resetVibePlatformSchemaCacheForTests,
  ensureVibePlatformSchema,
} from '../../server/services/vibe-platform-schema';

const existingAuditColumns = [{ name: 'platform_user_id' }];
const existingUserColumns = [{ name: 'is_active' }, { name: 'deleted_at' }, { name: 'admin' }];

describe('Vibe platform SQLite schema bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetVibePlatformSchemaCacheForTests();
    dbHelperMock.run.mockResolvedValue(undefined);
    dbHelperMock.all
      .mockResolvedValueOnce(existingAuditColumns)
      .mockResolvedValueOnce(existingUserColumns);
  });

  it('reads PRAGMA rows with all() and skips columns that already exist', async () => {
    await ensureVibePlatformSchema();

    expect(dbHelperMock.all).toHaveBeenCalledTimes(2);
    expect(dbHelperMock.run).toHaveBeenCalledTimes(VIBE_PLATFORM_CREATE_STATEMENTS.length);
  });

  it('serializes concurrent callers into one schema reconciliation', async () => {
    await Promise.all([ensureVibePlatformSchema(), ensureVibePlatformSchema()]);

    expect(dbHelperMock.all).toHaveBeenCalledTimes(2);
    expect(dbHelperMock.run).toHaveBeenCalledTimes(VIBE_PLATFORM_CREATE_STATEMENTS.length);
  });

  it('adds only the four missing legacy columns', async () => {
    dbHelperMock.all.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await ensureVibePlatformSchema();

    expect(dbHelperMock.run).toHaveBeenCalledTimes(VIBE_PLATFORM_CREATE_STATEMENTS.length + 4);
  });
});
