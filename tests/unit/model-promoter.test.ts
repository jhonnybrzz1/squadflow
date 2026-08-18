import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '@shared/schema';
import { ModelPromoter, type PromotionFaultPoint } from '../../server/services/model-promoter';
import { modelRegistry } from '../../server/services/model-registry';
import { clearModelFamiliesCache } from '../../server/services/model-family-rules';
import type { DbClient } from '../../server/db';

const SCHEMA_SQL = `
  CREATE TABLE model_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias TEXT NOT NULL UNIQUE,
    family TEXT NOT NULL,
    provider TEXT NOT NULL,
    active_model_id TEXT NOT NULL,
    fallback_model_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    source TEXT NOT NULL DEFAULT 'static-fallback',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_validated_at INTEGER,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_failure_at INTEGER,
    last_rollback_at INTEGER
  );
  CREATE TABLE model_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias TEXT NOT NULL,
    family TEXT NOT NULL,
    provider TEXT NOT NULL,
    current_model_id TEXT NOT NULL,
    candidate_model_id TEXT NOT NULL,
    candidate_version TEXT,
    status TEXT NOT NULL DEFAULT 'discovered',
    selection_reason TEXT,
    evidence TEXT DEFAULT '{}',
    capabilities TEXT DEFAULT '{}',
    discovered_at INTEGER NOT NULL,
    validated_at INTEGER,
    validation_error TEXT
  );
  CREATE TABLE model_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias TEXT NOT NULL,
    previous_model_id TEXT,
    new_model_id TEXT,
    action TEXT NOT NULL,
    reason TEXT,
    triggered_by TEXT NOT NULL DEFAULT 'system',
    created_at INTEGER NOT NULL,
    metadata TEXT DEFAULT '{}'
  );
`;

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(SCHEMA_SQL);
  const drizzleDb = drizzle(sqlite, { schema });
  const db = drizzleDb as unknown as DbClient;
  return { sqlite, db, drizzleDb };
}

const ALIAS = 'deepseek-v4-pro-latest';
const CURRENT_MODEL = 'deepseek/deepseek-v4-pro';
const CANDIDATE_MODEL = 'deepseek/deepseek-v5-pro';

describe('ModelPromoter', () => {
  let sqlite: Database.Database | null = null;
  let promoter: ModelPromoter | null = null;
  let db: DbClient | null = null;
  let drizzleDb: BetterSQLite3Database<typeof schema> | null = null;

  beforeEach(() => {
    clearModelFamiliesCache();
    modelRegistry.reset();
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    db = testDb.db;
    drizzleDb = testDb.drizzleDb;
    promoter = new ModelPromoter(testDb.db);

    // Seed an alias
    drizzleDb!
      .insert(schema.modelAliases)
      .values({
        alias: ALIAS,
        family: 'deepseek-v4-pro',
        provider: 'tencent',
        activeModelId: CURRENT_MODEL,
        status: 'active',
        source: 'static-fallback',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    // Seed a candidate
    drizzleDb!
      .insert(schema.modelCandidates)
      .values({
        alias: ALIAS,
        family: 'deepseek-v4-pro',
        provider: 'tencent',
        currentModelId: CURRENT_MODEL,
        candidateModelId: CANDIDATE_MODEL,
        candidateVersion: CANDIDATE_MODEL,
        status: 'discovered',
        selectionReason: 'candidate: higher-primary',
        evidence: {},
        capabilities: { contextLength: 1048576, inputModalities: ['text'] },
        discoveredAt: new Date(),
      })
      .run();
  });

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
    promoter = null;
    db = null;
    drizzleDb = null;
  });

  function getAlias(): { activeModelId: string } {
    const rows = drizzleDb!
      .select()
      .from(schema.modelAliases)
      .where(eq(schema.modelAliases.alias, ALIAS))
      .all();
    return rows[0] as { activeModelId: string };
  }

  function getHistory(): Array<{
    action: string;
    previousModelId: string | null;
    newModelId: string;
  }> {
    return drizzleDb!
      .select()
      .from(schema.modelHistory)
      .where(eq(schema.modelHistory.alias, ALIAS))
      .all() as Array<{ action: string; previousModelId: string | null; newModelId: string }>;
  }

  function getCandidates(): Array<{ id: number; status: string; validationError: string | null }> {
    return drizzleDb!
      .select()
      .from(schema.modelCandidates)
      .where(eq(schema.modelCandidates.alias, ALIAS))
      .all() as Array<{ id: number; status: string; validationError: string | null }>;
  }

  function getFailureState(): {
    failureCount: number;
    lastFailureAt: Date | null;
    lastRollbackAt: Date | null;
  } {
    const rows = drizzleDb!
      .select({
        failureCount: schema.modelAliases.failureCount,
        lastFailureAt: schema.modelAliases.lastFailureAt,
        lastRollbackAt: schema.modelAliases.lastRollbackAt,
      })
      .from(schema.modelAliases)
      .where(eq(schema.modelAliases.alias, ALIAS))
      .all();
    return (rows[0] ?? {
      failureCount: 0,
      lastFailureAt: null,
      lastRollbackAt: null,
    }) as {
      failureCount: number;
      lastFailureAt: Date | null;
      lastRollbackAt: Date | null;
    };
  }

  /**
   * MR-03 helper: validation is now a prerequisite for promotion. This
   * helper runs validate() with skipSmokeTest (test-only) then promote().
   */
  async function validateAndPromote(alias: string = ALIAS, candidateId: number = 1): Promise<void> {
    const v = await promoter!.validate({ alias, candidateId, skipSmokeTest: true });
    expect(v.success).toBe(true);
    const p = await promoter!.promote({ alias, candidateId, triggeredBy: 'test' });
    expect(p.success).toBe(true);
  }

  describe('validate', () => {
    it('rejects smoke-test bypass outside an isolated test environment', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const result = await promoter!.validate({
          alias: ALIAS,
          candidateId: 1,
          skipSmokeTest: true,
        });

        expect(result).toMatchObject({
          success: false,
          validationError: 'smoke-test-bypass-test-only',
        });
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('validates a discovered candidate with skipSmokeTest', async () => {
      const result = await promoter!.validate({
        alias: ALIAS,
        candidateId: 1,
        triggeredBy: 'test',
        skipSmokeTest: true,
      });

      expect(result.success).toBe(true);
      expect(result.candidateModelId).toBe(CANDIDATE_MODEL);

      const candidates = getCandidates();
      expect(candidates[0].status).toBe('validated');
    });

    it('rejects validation for non-existent candidate', async () => {
      const result = await promoter!.validate({
        alias: ALIAS,
        candidateId: 999,
        skipSmokeTest: true,
      });
      expect(result.success).toBe(false);
      expect(result.validationError).toBe('candidate-not-found');
    });

    it('rejects validation of an already-promoted candidate', async () => {
      await validateAndPromote();
      // The candidate is now 'promoted' — re-validating should fail
      const result = await promoter!.validate({
        alias: ALIAS,
        candidateId: 1,
        skipSmokeTest: true,
      });
      expect(result.success).toBe(false);
      expect(result.validationError).toContain('invalid-state');
    });
  });

  describe('promote', () => {
    it('promotes a previously-validated candidate', async () => {
      await validateAndPromote();

      expect(getAlias().activeModelId).toBe(CANDIDATE_MODEL);

      const history = getHistory();
      expect(history.length).toBe(1);
      expect(history[0].action).toBe('promoted');
      expect(history[0].previousModelId).toBe(CURRENT_MODEL);
      expect(history[0].newModelId).toBe(CANDIDATE_MODEL);
    });

    it('MR-03: rejects promotion of a discovered (non-validated) candidate', async () => {
      const result = await promoter!.promote({
        alias: ALIAS,
        candidateId: 1,
        triggeredBy: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.validationError).toContain('requires-validated-state');
      // Alias should NOT have been flipped
      expect(getAlias().activeModelId).toBe(CURRENT_MODEL);
    });

    it('rejects promotion for non-existent candidate', async () => {
      const result = await promoter!.promote({
        alias: ALIAS,
        candidateId: 999,
      });
      expect(result.success).toBe(false);
      expect(result.validationError).toBe('candidate-not-found');
    });

    it('rejects promotion for unknown family', async () => {
      const result = await promoter!.promote({
        alias: 'nonexistent-alias',
        candidateId: 1,
      });
      expect(result.success).toBe(false);
    });

    it('prevents concurrent promotions on the same alias', async () => {
      // Pre-validate so both promotions can attempt the CAS
      await promoter!.validate({ alias: ALIAS, candidateId: 1, skipSmokeTest: true });

      const [r1, r2] = await Promise.all([
        promoter!.promote({ alias: ALIAS, candidateId: 1 }),
        promoter!.promote({ alias: ALIAS, candidateId: 1 }),
      ]);

      const successes = [r1, r2].filter((r) => r.success);
      const blocked = [r1, r2].filter((r) => !r.success);
      expect(successes.length).toBe(1);
      expect(blocked.length).toBe(1);
      expect(blocked[0].validationError).toBe('promotion-in-progress');
    });
  });

  describe('reject', () => {
    it('rejects a candidate', async () => {
      const result = await promoter!.reject(ALIAS, 1, 'test', 'not suitable');
      expect(result.success).toBe(true);

      const candidates = getCandidates();
      expect(candidates[0].status).toBe('rejected');
      expect(candidates[0].validationError).toBe('not suitable');
    });
  });

  describe('rollback', () => {
    it('rolls back to previous model after promotion', async () => {
      await validateAndPromote();
      expect(getAlias().activeModelId).toBe(CANDIDATE_MODEL);

      const result = await promoter!.rollback({
        alias: ALIAS,
        triggeredBy: 'test',
        reason: 'testing',
      });

      expect(result.success).toBe(true);
      expect(result.restoredModelId).toBe(CURRENT_MODEL);
      expect(getAlias().activeModelId).toBe(CURRENT_MODEL);

      const history = getHistory();
      const rollbackEntry = history.find((h) => h.action === 'rolled_back');
      expect(rollbackEntry).toBeDefined();
      expect(rollbackEntry!.previousModelId).toBe(CANDIDATE_MODEL);
      expect(rollbackEntry!.newModelId).toBe(CURRENT_MODEL);
    });

    it('fails rollback when no promotion history exists', async () => {
      const result = await promoter!.rollback({ alias: ALIAS });
      expect(result.success).toBe(false);
      expect(result.reason).toBe('no-history');
    });

    it('rollback is idempotent (second rollback finds previous promotion)', async () => {
      await validateAndPromote();
      await promoter!.rollback({ alias: ALIAS });
      // Second rollback should find the rolled_back entry and restore from it
      const result = await promoter!.rollback({ alias: ALIAS });
      expect(result.success).toBe(true);
    });
  });

  describe('recordFailure (auto-rollback)', () => {
    it('does not rollback below threshold', async () => {
      process.env.MODEL_ROLLBACK_THRESHOLD = '3';
      for (let i = 0; i < 2; i++) {
        const result = await promoter!.recordFailure(ALIAS);
        expect(result.rolledBack).toBe(false);
      }
      delete process.env.MODEL_ROLLBACK_THRESHOLD;
    });

    it('triggers auto-rollback at threshold after promotion', async () => {
      process.env.MODEL_ROLLBACK_THRESHOLD = '2';
      process.env.MODEL_ROLLBACK_COOLDOWN_MS = '0';

      await validateAndPromote();

      const r1 = await promoter!.recordFailure(ALIAS);
      expect(r1.rolledBack).toBe(false);

      const r2 = await promoter!.recordFailure(ALIAS);
      expect(r2.rolledBack).toBe(true);

      expect(getAlias().activeModelId).toBe(CURRENT_MODEL);

      delete process.env.MODEL_ROLLBACK_THRESHOLD;
      delete process.env.MODEL_ROLLBACK_COOLDOWN_MS;
    });
  });

  describe('listHistory', () => {
    it('returns history entries', async () => {
      await validateAndPromote();
      const history = await promoter!.listHistory(ALIAS);
      expect(history.length).toBe(1);
      expect((history[0] as { action: string }).action).toBe('promoted');
    });
  });

  // ── MR-02: CAS-verified promotion + fault injection ──────────────────────
  describe('MR-02: compare-and-set verification', () => {
    it('aborts promotion when candidate state is flipped between validate and promote', async () => {
      // Validate the candidate (status -> validated)
      const v = await promoter!.validate({ alias: ALIAS, candidateId: 1, skipSmokeTest: true });
      expect(v.success).toBe(true);

      // Simulate a concurrent writer flipping the candidate to 'rejected'
      // between validate() and promote(). The CAS in promote() should
      // detect this and abort the transaction.
      drizzleDb!
        .update(schema.modelCandidates)
        .set({ status: 'rejected' })
        .where(eq(schema.modelCandidates.id, 1))
        .run();

      const result = await promoter!.promote({ alias: ALIAS, candidateId: 1, triggeredBy: 'test' });

      // MR-02: CAS failed — promotion aborted.
      expect(result.success).toBe(false);
      // The alias should NOT have been flipped to the candidate model
      expect(getAlias().activeModelId).toBe(CURRENT_MODEL);
      // No 'promoted' history entry should exist
      const history = getHistory();
      expect(history.find((h) => h.action === 'promoted')).toBeUndefined();
    });

    it('does not leave the alias flipped when CAS fails (transaction rollback)', async () => {
      // Validate, then flip the candidate to 'promoted' (concurrent writer
      // already promoted it). The CAS should find zero rows and abort.
      await promoter!.validate({ alias: ALIAS, candidateId: 1, skipSmokeTest: true });
      drizzleDb!
        .update(schema.modelCandidates)
        .set({ status: 'promoted' })
        .where(eq(schema.modelCandidates.id, 1))
        .run();

      const result = await promoter!.promote({ alias: ALIAS, candidateId: 1, triggeredBy: 'test' });

      expect(result.success).toBe(false);
      // Alias must still point at the original model (transaction rolled back)
      expect(getAlias().activeModelId).toBe(CURRENT_MODEL);
    });

    it.each<PromotionFaultPoint>([
      'before-alias-write',
      'before-candidate-write',
      'before-history-write',
      'before-commit',
    ])('rolls back all writes when fault injection fails at %s', async (faultPoint) => {
      await promoter!.validate({ alias: ALIAS, candidateId: 1, skipSmokeTest: true });
      const faultingPromoter = new ModelPromoter(db!, {
        onPromotionStep: (point) => {
          if (point === faultPoint) throw new Error(`injected:${point}`);
        },
      });

      const result = await faultingPromoter.promote({
        alias: ALIAS,
        candidateId: 1,
        triggeredBy: 'fault-test',
      });

      expect(result.success).toBe(false);
      expect(result.validationError).toBe(`injected:${faultPoint}`);
      expect(getAlias().activeModelId).toBe(CURRENT_MODEL);
      expect(getCandidates()[0].status).toBe('validated');
      expect(getHistory()).toHaveLength(0);
    });

    it.each<{
      point: PromotionFaultPoint;
      warning: 'cache_invalidation_failed' | 'failure_state_reset_failed';
    }>([
      {
        point: 'before-cache-invalidation',
        warning: 'cache_invalidation_failed',
      },
      {
        point: 'before-failure-state-reset',
        warning: 'failure_state_reset_failed',
      },
    ])('reports committed promotion truth when $point fails', async ({ point, warning }) => {
      await promoter!.validate({ alias: ALIAS, candidateId: 1, skipSmokeTest: true });
      const faultingPromoter = new ModelPromoter(db!, {
        onPromotionStep: (currentPoint) => {
          if (currentPoint === point) throw new Error(`injected:${currentPoint}`);
        },
      });

      const result = await faultingPromoter.promote({
        alias: ALIAS,
        candidateId: 1,
        triggeredBy: 'fault-test',
      });

      expect(result.success).toBe(true);
      expect(result.validationError).toBeUndefined();
      expect(result.postCommitWarnings).toEqual([warning]);
      expect(getAlias().activeModelId).toBe(CANDIDATE_MODEL);
      expect(getCandidates()[0].status).toBe('promoted');
      expect(getHistory()).toHaveLength(1);
    });
  });

  // ── MR-05: Persisted auto-rollback state ──────────────────────────────────
  describe('MR-05: persisted failure count', () => {
    it('persists failure count across calls (survives restart simulation)', async () => {
      process.env.MODEL_ROLLBACK_THRESHOLD = '5';
      process.env.MODEL_ROLLBACK_COOLDOWN_MS = '900000';

      // Record 3 failures
      for (let i = 0; i < 3; i++) {
        await promoter!.recordFailure(ALIAS);
      }

      // MR-05: The failure count is persisted in the database, not just
      // in-memory. A new promoter instance (simulating a restart) should
      // see the persisted count.
      const restartedPromoter = new ModelPromoter(db!);
      const state = getFailureState();
      expect(state.failureCount).toBe(3);
      expect(state.lastFailureAt).not.toBeNull();

      // The restarted promoter should continue from the persisted count.
      // Recording 2 more failures (total 5) should trigger rollback.
      await validateAndPromote();
      expect(getAlias().activeModelId).toBe(CANDIDATE_MODEL);

      // Reset threshold for this part of the test
      process.env.MODEL_ROLLBACK_THRESHOLD = '5';
      // Reset the failure count by promoting (which resets it)
      const r1 = await restartedPromoter.recordFailure(ALIAS);
      expect(r1.rolledBack).toBe(false);
      expect(getFailureState().failureCount).toBe(1);

      const r2 = await restartedPromoter.recordFailure(ALIAS);
      expect(r2.rolledBack).toBe(false);
      expect(getFailureState().failureCount).toBe(2);

      delete process.env.MODEL_ROLLBACK_THRESHOLD;
      delete process.env.MODEL_ROLLBACK_COOLDOWN_MS;
    });

    it('resets failure count on successful promotion', async () => {
      process.env.MODEL_ROLLBACK_THRESHOLD = '5';

      // Record some failures
      for (let i = 0; i < 3; i++) {
        await promoter!.recordFailure(ALIAS);
      }
      expect(getFailureState().failureCount).toBe(3);

      // Promote — should reset the failure count
      await validateAndPromote();
      expect(getFailureState().failureCount).toBe(0);

      delete process.env.MODEL_ROLLBACK_THRESHOLD;
    });

    it('atomically counts at least ten concurrent failures without lost increments', async () => {
      process.env.MODEL_ROLLBACK_THRESHOLD = '100';
      const results = await Promise.all(
        Array.from({ length: 12 }, () => promoter!.recordFailure(ALIAS)),
      );
      expect(results.every((result) => !result.rolledBack)).toBe(true);
      expect(getFailureState().failureCount).toBe(12);
      delete process.env.MODEL_ROLLBACK_THRESHOLD;
    });

    it('preserves pre-attempt failure state when auto-rollback transaction fails', async () => {
      process.env.MODEL_ROLLBACK_THRESHOLD = '2';
      process.env.MODEL_ROLLBACK_COOLDOWN_MS = '60000';
      await validateAndPromote();
      await promoter!.recordFailure(ALIAS);
      expect(getFailureState().failureCount).toBe(1);

      const faultingPromoter = new ModelPromoter(db!, {
        onAutoRollbackStep: (point) => {
          if (point === 'before-history-write') throw new Error('injected-auto-rollback-failure');
        },
      });
      const result = await faultingPromoter.recordFailure(ALIAS);
      expect(result).toEqual({ rolledBack: false, reason: 'exception' });
      expect(getAlias().activeModelId).toBe(CANDIDATE_MODEL);
      expect(getFailureState().failureCount).toBe(1);
      expect(getHistory().filter((entry) => entry.action === 'auto_rolled_back')).toHaveLength(0);

      delete process.env.MODEL_ROLLBACK_THRESHOLD;
      delete process.env.MODEL_ROLLBACK_COOLDOWN_MS;
    });

    it('persists cooldown across instances and keeps a second rollback idempotent', async () => {
      process.env.MODEL_ROLLBACK_THRESHOLD = '2';
      process.env.MODEL_ROLLBACK_COOLDOWN_MS = '60000';
      await validateAndPromote();
      await promoter!.recordFailure(ALIAS);
      expect((await promoter!.recordFailure(ALIAS)).rolledBack).toBe(true);
      expect(getFailureState().lastRollbackAt).not.toBeNull();

      const restartedPromoter = new ModelPromoter(db!);
      expect((await restartedPromoter.recordFailure(ALIAS)).rolledBack).toBe(false);
      expect(await restartedPromoter.recordFailure(ALIAS)).toEqual({
        rolledBack: false,
        reason: 'cooldown',
      });
      expect(getHistory().filter((entry) => entry.action === 'auto_rolled_back')).toHaveLength(1);

      delete process.env.MODEL_ROLLBACK_THRESHOLD;
      delete process.env.MODEL_ROLLBACK_COOLDOWN_MS;
    });
  });
});
