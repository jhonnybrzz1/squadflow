/**
 * ModelPromoter — validates candidates, promotes them transactionally, and
 * supports rollback.
 *
 * Promotion flow (security rules 3.2, 12):
 *  1. Validate the candidate exists in the catalog and belongs to the
 *     homologated provider.
 *  2. Run a smoke test (small, deterministic prompt) against the candidate.
 *  3. In a transaction: record previous model id, update active model id,
 *     invalidate cache, record history with a rollback point.
 *  4. Emit structured log + metric.
 *
 * Rollback:
 *  - Manual via admin API.
 *  - Automatic by failure threshold (when enabled).
 *  - Transactional, idempotent, auditable.
 *
 * Concurrent promotion protection: a per-alias in-memory lock prevents two
 * promotions from racing on the same alias.
 */

import { eq, and, sql } from 'drizzle-orm';
import { db as defaultDb, dbTransaction, type DbClient } from '../db';
import { modelAliases, modelCandidates, modelHistory } from '@shared/schema-unified';
import type { ModelCandidate, ModelHistoryAction } from '@shared/schema';
import { logger } from '../utils/logger';
import { findFamilyByAlias, isEligibleCandidate } from './model-family-rules';
import { modelRegistry } from './model-registry';
import { asWriter, asReader } from './drizzle-helpers';
import {
  modelPromotionTotal,
  modelPromotionFailureTotal,
  modelRollbackTotal,
  modelValidationDurationMs,
} from '../metrics/model-registry';

export interface ValidationOptions {
  alias: string;
  candidateId: number;
  triggeredBy?: string;
  skipSmokeTest?: boolean;
}

export interface ValidationResult {
  success: boolean;
  alias: string;
  candidateModelId: string;
  validationError?: string;
}

export interface PromotionOptions {
  alias: string;
  candidateId: number;
  triggeredBy?: string;
  reason?: string;
  /** Internal/test-only: skip the state-gate check. HTTP API never sets this. */
  skipStateGate?: boolean;
}

export interface PromotionResult {
  success: boolean;
  alias: string;
  previousModelId: string | null;
  newModelId: string;
  validationError?: string;
  postCommitWarnings?: Array<'cache_invalidation_failed' | 'failure_state_reset_failed'>;
}

export type PromotionFaultPoint =
  | 'before-alias-write'
  | 'before-candidate-write'
  | 'before-history-write'
  | 'before-commit'
  | 'before-cache-invalidation'
  | 'before-failure-state-reset';

export interface ModelPromoterTestHooks {
  onPromotionStep?(point: PromotionFaultPoint): void | Promise<void>;
  onAutoRollbackStep?(
    point: 'before-alias-write' | 'before-history-write' | 'before-commit',
  ): void | Promise<void>;
}

export interface RollbackOptions {
  alias: string;
  triggeredBy?: string;
  reason?: string;
}

export interface RollbackResult {
  success: boolean;
  alias: string;
  restoredModelId: string | null;
  reason?: string;
}

// ── Smoke test ──────────────────────────────────────────────────────────────

const SMOKE_TEST_PROMPT = 'Reply with exactly: OK';
const SMOKE_TEST_MAX_TOKENS = 10;

/**
 * Runs a minimal smoke test against a candidate model. Returns null on
 * success, or an error message on failure. Does NOT expose user content.
 *
 * The smoke test is optional and skipped when:
 *  - skipSmokeTest is true in an isolated test process;
 *  - the provider client is unavailable (validation is deferred to runtime
 *    fallback, which will trigger auto-rollback if the model fails).
 */
async function runSmokeTest(modelId: string, provider: string): Promise<string | null> {
  const start = Date.now();
  try {
    // Lazy import to avoid circular dependency at module load time.
    const { llmClientManager } = await import('./llm-client-manager');
    const client = llmClientManager.getClient(provider as never);

    const completion = await client.chat.completions.create({
      model: modelId,
      messages: [{ role: 'user', content: SMOKE_TEST_PROMPT }],
      max_tokens: SMOKE_TEST_MAX_TOKENS,
      temperature: 0,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content || content.trim().length === 0) {
      return 'empty-response';
    }
    return null;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `smoke-test-error: ${msg}`;
  } finally {
    modelValidationDurationMs.labels(provider).observe(Date.now() - start);
  }
}

// ── Promoter ────────────────────────────────────────────────────────────────

export class ModelPromoter {
  private promotionLocks = new Set<string>();

  constructor(
    private readonly database: DbClient = defaultDb,
    private readonly testHooks: ModelPromoterTestHooks = {},
  ) {}

  private get rollbackThreshold(): number {
    return parseInt(process.env.MODEL_ROLLBACK_THRESHOLD || '5', 10);
  }

  private get rollbackCooldownMs(): number {
    return parseInt(process.env.MODEL_ROLLBACK_COOLDOWN_MS || '900000', 10);
  }

  /**
   * MR-03: Validates a discovered candidate by running the smoke test and
   * marking it `validated`. This is a prerequisite for promotion —
   * `promote()` now requires `status = validated`. Separating validation
   * from promotion makes the gate auditable: a candidate must prove it
   * responds before it can be promoted, and the state transition is
   * observable in the candidates table.
   */
  async validate(options: ValidationOptions): Promise<ValidationResult> {
    const { alias, candidateId, triggeredBy = 'admin', skipSmokeTest = false } = options;

    if (skipSmokeTest && process.env.NODE_ENV !== 'test') {
      return {
        success: false,
        alias,
        candidateModelId: '',
        validationError: 'smoke-test-bypass-test-only',
      };
    }

    if (this.promotionLocks.has(alias)) {
      return {
        success: false,
        alias,
        candidateModelId: '',
        validationError: 'promotion-in-progress',
      };
    }
    this.promotionLocks.add(alias);

    try {
      const candidate = await this.loadCandidate(alias, candidateId);
      if (!candidate) {
        return {
          success: false,
          alias,
          candidateModelId: '',
          validationError: 'candidate-not-found',
        };
      }

      const family = findFamilyByAlias(alias);
      if (!family) {
        return {
          success: false,
          alias,
          candidateModelId: candidate.candidateModelId,
          validationError: 'family-not-found',
        };
      }

      // Binding integrity (CRIT-04)
      if (candidate.family !== family.family || candidate.provider !== family.provider) {
        return {
          success: false,
          alias,
          candidateModelId: candidate.candidateModelId,
          validationError: `candidate-mismatch: family=${candidate.family}/${family.family} provider=${candidate.provider}/${family.provider}`,
        };
      }

      // Only discovered or validation_failed candidates can be validated.
      const VALIDATABLE = ['discovered', 'validation_failed'];
      if (!VALIDATABLE.includes(candidate.status)) {
        return {
          success: false,
          alias,
          candidateModelId: candidate.candidateModelId,
          validationError: `invalid-state:${candidate.status}`,
        };
      }

      // Eligibility check
      const eligibility = isEligibleCandidate(family, candidate.candidateModelId, {
        contextLength: (candidate.capabilities as { contextLength?: number })?.contextLength,
        inputModalities: (candidate.capabilities as { inputModalities?: string[] })
          ?.inputModalities,
      });
      if (!eligibility.eligible) {
        await this.markCandidateValidated(candidate, false, `ineligible: ${eligibility.reason}`);
        return {
          success: false,
          alias,
          candidateModelId: candidate.candidateModelId,
          validationError: `ineligible: ${eligibility.reason}`,
        };
      }

      // Smoke test
      if (!skipSmokeTest) {
        const smokeError = await runSmokeTest(candidate.candidateModelId, candidate.provider);
        if (smokeError) {
          await this.markCandidateValidated(candidate, false, smokeError);
          return {
            success: false,
            alias,
            candidateModelId: candidate.candidateModelId,
            validationError: `smoke-test-failed: ${smokeError}`,
          };
        }
      }

      // Mark validated
      await this.markCandidateValidated(candidate, true);
      logger.info('[model-promoter] Candidate validated', {
        context: { alias, candidateId, modelId: candidate.candidateModelId, triggeredBy },
      });

      return {
        success: true,
        alias,
        candidateModelId: candidate.candidateModelId,
      };
    } catch (error) {
      logger.error('[model-promoter] Validation failed', {
        error: error instanceof Error ? error : undefined,
        context: { alias, candidateId },
      });
      return {
        success: false,
        alias,
        candidateModelId: '',
        validationError: error instanceof Error ? error.message : 'exception',
      };
    } finally {
      this.promotionLocks.delete(alias);
    }
  }

  /**
   * MR-02/MR-03: Promotes a *previously validated* candidate to active.
   * Transactional, with history and rollback point. Protected against
   * concurrent promotions on the same alias.
   *
   * MR-03: The candidate must already have `status = validated`. A
   * `discovered` candidate must be validated via `validate()` first.
   *
   * MR-02: The compare-and-set update verifies that exactly one row was
   * changed; if zero rows match (concurrent writer, stale state), the
   * transaction is aborted.
   */
  async promote(options: PromotionOptions): Promise<PromotionResult> {
    const { alias, candidateId, triggeredBy = 'admin', reason } = options;

    // Concurrent promotion lock
    if (this.promotionLocks.has(alias)) {
      return {
        success: false,
        alias,
        previousModelId: null,
        newModelId: '',
        validationError: 'promotion-in-progress',
      };
    }
    this.promotionLocks.add(alias);

    try {
      // 1. Load candidate
      const candidate = await this.loadCandidate(alias, candidateId);
      if (!candidate) {
        modelPromotionFailureTotal.inc({
          provider: 'unknown',
          family: 'unknown',
          reason: 'candidate-not-found',
        });
        return {
          success: false,
          alias,
          previousModelId: null,
          newModelId: '',
          validationError: 'candidate-not-found',
        };
      }

      const family = findFamilyByAlias(alias);
      if (!family) {
        return this.fail(
          alias,
          null,
          candidate.candidateModelId,
          'family-not-found',
          candidate.provider,
        );
      }

      // 1b. Binding integrity (CRIT-04)
      if (candidate.family !== family.family || candidate.provider !== family.provider) {
        return this.fail(
          alias,
          candidate.currentModelId,
          candidate.candidateModelId,
          `candidate-mismatch: family=${candidate.family}/${family.family} provider=${candidate.provider}/${family.provider}`,
          candidate.provider,
        );
      }

      // 1c. MR-03 state gate: the candidate MUST already be `validated`.
      // A `discovered` candidate must be validated via `validate()` first.
      // This makes the gate auditable — promotion no longer silently
      // validates + promotes in one step.
      if (!options.skipStateGate) {
        if (candidate.status !== 'validated') {
          return this.fail(
            alias,
            candidate.currentModelId,
            candidate.candidateModelId,
            `requires-validated-state:current=${candidate.status}`,
            candidate.provider,
          );
        }
      }

      // Terminal statuses are always rejected even with skipStateGate.
      const TERMINAL_STATUSES = ['promoted', 'rejected', 'superseded'];
      if (TERMINAL_STATUSES.includes(candidate.status)) {
        return this.fail(
          alias,
          candidate.currentModelId,
          candidate.candidateModelId,
          `invalid-state:${candidate.status}`,
          candidate.provider,
        );
      }

      // 2. Validate eligibility (family rules) — re-check at promotion time
      const eligibility = isEligibleCandidate(family, candidate.candidateModelId, {
        contextLength: (candidate.capabilities as { contextLength?: number })?.contextLength,
        inputModalities: (candidate.capabilities as { inputModalities?: string[] })
          ?.inputModalities,
      });
      if (!eligibility.eligible) {
        return this.fail(
          alias,
          candidate.currentModelId,
          candidate.candidateModelId,
          `ineligible: ${eligibility.reason}`,
          candidate.provider,
        );
      }

      // 3-5. MR-02: Atomic promotion with verified compare-and-set.
      // The CAS update on modelCandidates uses .returning() to confirm that
      // exactly one row was changed. If zero rows match (concurrent writer
      // flipped the state, or the candidate was already promoted), the
      // transaction is aborted by throwing — no alias flip or history
      // entry is written.
      const previousModelId = candidate.currentModelId;
      const newModelId = candidate.candidateModelId;
      const now = new Date();

      await dbTransaction(async (tx) => {
        await this.testHooks.onPromotionStep?.('before-alias-write');
        // Flip the active model id.
        await asWriter(tx)
          .update(modelAliases)
          .set({
            activeModelId: newModelId,
            updatedAt: now,
            lastValidatedAt: now,
            source: 'database',
          })
          .where(eq(modelAliases.alias, alias));

        await this.testHooks.onPromotionStep?.('before-candidate-write');
        // MR-02: Compare-and-set with rowCount verification. Only flip to
        // 'promoted' from 'validated'. If zero rows are returned, a
        // concurrent writer changed the state — abort the transaction.
        // Cast to any because DrizzleWriter's returning() is typed as
        // optional, but it exists on both SQLite and PG runtimes.
        const casResult = (await (asWriter(tx) as any)
          .update(modelCandidates)
          .set({ status: 'promoted' })
          .where(and(eq(modelCandidates.id, candidateId), eq(modelCandidates.status, 'validated')))
          .returning({ id: modelCandidates.id })) as Array<{ id: number }>;

        if (!casResult || casResult.length === 0) {
          // MR-02: CAS failed — abort. The transaction will roll back the
          // alias flip above, so the alias is never left pointing at a
          // candidate that wasn't marked promoted.
          throw new Error('CAS_FAILED: candidate was not in validated state');
        }

        await this.testHooks.onPromotionStep?.('before-history-write');
        await asWriter(tx)
          .insert(modelHistory)
          .values({
            alias,
            previousModelId,
            newModelId,
            action: 'promoted' as ModelHistoryAction,
            reason: reason ?? 'Manual promotion',
            triggeredBy,
            metadata: { candidateId, family: family.family },
          });
        await this.testHooks.onPromotionStep?.('before-commit');
      }, this.database);

      // Post-commit work cannot change the truth of the committed promotion.
      // Surface bounded warnings instead of returning a false failure that
      // could cause callers to retry an already-effective promotion.
      const postCommitWarnings: PromotionResult['postCommitWarnings'] = [];
      try {
        await this.testHooks.onPromotionStep?.('before-cache-invalidation');
        await modelRegistry.invalidate(alias);
      } catch (error) {
        postCommitWarnings.push('cache_invalidation_failed');
        logger.warn('[model-promoter] Post-commit cache invalidation failed', {
          error: error instanceof Error ? error : undefined,
          context: { alias, candidateId },
        });
      }

      try {
        await this.testHooks.onPromotionStep?.('before-failure-state-reset');
        await this.persistFailureState(alias, 0, null);
      } catch (error) {
        postCommitWarnings.push('failure_state_reset_failed');
        logger.warn('[model-promoter] Post-commit failure-state reset failed', {
          error: error instanceof Error ? error : undefined,
          context: { alias, candidateId },
        });
      }

      modelPromotionTotal.inc({
        provider: candidate.provider,
        family: family.family,
        result: 'success',
      });
      logger.info('[model-promoter] Promotion successful', {
        context: {
          alias,
          previousModelId,
          newModelId,
          triggeredBy,
          family: family.family,
        },
      });

      return {
        success: true,
        alias,
        previousModelId,
        newModelId,
        ...(postCommitWarnings.length > 0 ? { postCommitWarnings } : {}),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      modelPromotionFailureTotal.inc({
        provider: 'unknown',
        family: 'unknown',
        reason: 'exception',
      });
      logger.error('[model-promoter] Promotion failed', {
        error: error instanceof Error ? error : undefined,
        context: { alias, candidateId },
      });
      return {
        success: false,
        alias,
        previousModelId: null,
        newModelId: '',
        validationError: msg,
      };
    } finally {
      this.promotionLocks.delete(alias);
    }
  }

  /**
   * Rejects a candidate (marks it as rejected, no promotion).
   */
  async reject(
    alias: string,
    candidateId: number,
    triggeredBy = 'admin',
    reason?: string,
  ): Promise<{ success: boolean; reason?: string }> {
    try {
      const candidate = await this.loadCandidate(alias, candidateId);
      if (!candidate) {
        return { success: false, reason: 'candidate-not-found' };
      }

      await dbTransaction(async (tx) => {
        await asWriter(tx)
          .update(modelCandidates)
          .set({ status: 'rejected', validationError: reason })
          .where(eq(modelCandidates.id, candidateId));

        await asWriter(tx)
          .insert(modelHistory)
          .values({
            alias,
            previousModelId: candidate.currentModelId,
            newModelId: candidate.candidateModelId,
            action: 'rejected' as ModelHistoryAction,
            reason: reason ?? 'Manual rejection',
            triggeredBy,
            metadata: { candidateId },
          });
      }, this.database);

      return { success: true };
    } catch (error) {
      logger.error('[model-promoter] Reject failed', {
        error: error instanceof Error ? error : undefined,
        context: { alias, candidateId },
      });
      return { success: false, reason: 'exception' };
    }
  }

  /**
   * Rolls back an alias to its previous model id. Looks up the last promotion
   * in history and restores the previous model id. Idempotent.
   */
  async rollback(options: RollbackOptions): Promise<RollbackResult> {
    const { alias, triggeredBy = 'admin', reason } = options;

    try {
      // Find the last promotion for this alias
      const historyRows = (await asReader(this.database)
        .select()
        .from(modelHistory)
        .where(eq(modelHistory.alias, alias))
        .orderBy(sql`created_at DESC`)
        .limit(1)) as unknown as unknown[];

      if (historyRows.length === 0) {
        return { success: false, alias, restoredModelId: null, reason: 'no-history' };
      }

      const lastEntry = historyRows[0] as ModelCandidate & {
        previousModelId: string | null;
        newModelId: string;
        action: string;
      };

      if (lastEntry.action !== 'promoted' && lastEntry.action !== 'auto_rolled_back') {
        return { success: false, alias, restoredModelId: null, reason: 'no-rollback-point' };
      }

      if (!lastEntry.previousModelId) {
        return { success: false, alias, restoredModelId: null, reason: 'no-previous-model' };
      }

      const restoredModelId = lastEntry.previousModelId;
      const family = findFamilyByAlias(alias);

      // Atomic rollback (CRIT-03): restore the previous active model id and
      // record the rollback history in a single transaction.
      await dbTransaction(async (tx) => {
        await asWriter(tx)
          .update(modelAliases)
          .set({
            activeModelId: restoredModelId,
            updatedAt: new Date(),
            source: 'database',
          })
          .where(eq(modelAliases.alias, alias));

        await asWriter(tx)
          .insert(modelHistory)
          .values({
            alias,
            previousModelId: lastEntry.newModelId,
            newModelId: restoredModelId,
            action: 'rolled_back' as ModelHistoryAction,
            reason: reason ?? 'Manual rollback',
            triggeredBy,
            metadata: { restoredFrom: lastEntry.newModelId },
          });
      }, this.database);

      await modelRegistry.invalidate(alias);

      modelRollbackTotal.inc({
        provider: family?.provider ?? 'unknown',
        family: family?.family ?? 'unknown',
        trigger: triggeredBy === 'auto' ? 'auto' : 'manual',
      });

      logger.info('[model-promoter] Rollback successful', {
        context: { alias, restoredModelId, triggeredBy },
      });

      return { success: true, alias, restoredModelId };
    } catch (error) {
      logger.error('[model-promoter] Rollback failed', {
        error: error instanceof Error ? error : undefined,
        context: { alias },
      });
      return { success: false, alias, restoredModelId: null, reason: 'exception' };
    }
  }

  /**
   * Records a failure for an alias. When the failure count exceeds the
   * threshold (and cooldown has elapsed), triggers an automatic rollback.
   * Only restores a previously validated model.
   *
   * Failure increment, threshold evaluation, alias restoration, state reset
   * and the single auto_rolled_back history row share one transaction.
   * last_rollback_at (not last_failure_at) anchors the persisted cooldown.
   */
  async recordFailure(alias: string): Promise<{ rolledBack: boolean; reason?: string }> {
    const now = new Date();
    try {
      const result = await dbTransaction(async (tx) => {
        const incremented = (await (asWriter(tx) as any)
          .update(modelAliases)
          .set({
            failureCount: sql`${modelAliases.failureCount} + 1`,
            lastFailureAt: now,
          })
          .where(eq(modelAliases.alias, alias))
          .returning({
            activeModelId: modelAliases.activeModelId,
            failureCount: modelAliases.failureCount,
            lastRollbackAt: modelAliases.lastRollbackAt,
          })) as Array<{
          activeModelId: string;
          failureCount: number;
          lastRollbackAt: Date | null;
        }>;

        if (incremented.length === 0) {
          return { rolledBack: false, reason: 'alias-not-found' };
        }

        const state = incremented[0];
        if (state.failureCount < this.rollbackThreshold) {
          return { rolledBack: false };
        }

        if (
          state.lastRollbackAt &&
          now.getTime() - state.lastRollbackAt.getTime() < this.rollbackCooldownMs
        ) {
          return { rolledBack: false, reason: 'cooldown' };
        }

        const rollbackPoints = (await asReader(tx)
          .select()
          .from(modelHistory)
          .where(
            and(
              eq(modelHistory.alias, alias),
              eq(modelHistory.action, 'promoted' as ModelHistoryAction),
            ),
          )
          .orderBy(sql`created_at DESC, id DESC`)
          .limit(1)) as unknown as Array<{
          previousModelId: string | null;
          newModelId: string | null;
        }>;
        const rollbackPoint = rollbackPoints[0];
        if (
          !rollbackPoint?.previousModelId ||
          !rollbackPoint.newModelId ||
          rollbackPoint.newModelId !== state.activeModelId
        ) {
          return { rolledBack: false, reason: 'no-rollback-point' };
        }

        await this.testHooks.onAutoRollbackStep?.('before-alias-write');
        await asWriter(tx)
          .update(modelAliases)
          .set({
            activeModelId: rollbackPoint.previousModelId,
            failureCount: 0,
            lastFailureAt: null,
            lastRollbackAt: now,
            updatedAt: now,
            source: 'database',
          })
          .where(eq(modelAliases.alias, alias));

        await this.testHooks.onAutoRollbackStep?.('before-history-write');
        await asWriter(tx)
          .insert(modelHistory)
          .values({
            alias,
            previousModelId: state.activeModelId,
            newModelId: rollbackPoint.previousModelId,
            action: 'auto_rolled_back' as ModelHistoryAction,
            reason: `Automatic rollback after ${state.failureCount} failures`,
            triggeredBy: 'auto',
            metadata: { failureCount: state.failureCount },
          });
        await this.testHooks.onAutoRollbackStep?.('before-commit');

        return { rolledBack: true, restoredModelId: rollbackPoint.previousModelId };
      }, this.database);

      if (result.rolledBack) {
        try {
          await modelRegistry.invalidate(alias);
        } catch (error) {
          logger.warn('[model-promoter] Auto-rollback cache invalidation failed', {
            error: error instanceof Error ? error : undefined,
            context: { alias },
          });
        }
        const family = findFamilyByAlias(alias);
        modelRollbackTotal.inc({
          provider: family?.provider ?? 'unknown',
          family: family?.family ?? 'unknown',
          trigger: 'auto',
        });
      }

      return { rolledBack: result.rolledBack, reason: result.reason };
    } catch (error) {
      logger.error('[model-promoter] Auto-rollback transaction failed', {
        error: error instanceof Error ? error : undefined,
        context: { alias },
      });
      return { rolledBack: false, reason: 'exception' };
    }
  }

  /**
   * MR-05: Persists the failure count and last-failure timestamp for an
   * alias. Used by recordFailure to make auto-rollback state survive
   * process restarts.
   */
  private async persistFailureState(
    alias: string,
    count: number,
    lastFailureAt: Date | null,
  ): Promise<void> {
    await asWriter(this.database)
      .update(modelAliases)
      .set({ failureCount: count, lastFailureAt })
      .where(eq(modelAliases.alias, alias));
  }

  /**
   * Lists the promotion history for an alias.
   */
  async listHistory(alias?: string): Promise<ModelCandidate[]> {
    let query = asReader(this.database).select().from(modelHistory);
    if (alias) {
      query = query.where(eq(modelHistory.alias, alias));
    }
    query = query.orderBy(sql`created_at DESC`).limit(100);
    return (await query) as unknown as ModelCandidate[];
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Loads a candidate strictly by (id AND alias). Binding to the alias prevents
   * promoting/rejecting a candidate that belongs to a *different* alias by
   * passing an unrelated candidate id (CRIT-04).
   */
  private async loadCandidate(alias: string, candidateId: number): Promise<ModelCandidate | null> {
    const rows = (await asReader(this.database)
      .select()
      .from(modelCandidates)
      .where(and(eq(modelCandidates.id, candidateId), eq(modelCandidates.alias, alias)))
      .limit(1)) as unknown as unknown[];
    return (rows[0] as ModelCandidate | undefined) ?? null;
  }

  private async markCandidateValidated(
    candidate: ModelCandidate,
    success: boolean,
    error?: string,
  ): Promise<void> {
    await asWriter(this.database)
      .update(modelCandidates)
      .set({
        status: success ? 'validated' : 'validation_failed',
        validatedAt: new Date(),
        validationError: error ?? null,
      })
      .where(eq(modelCandidates.id, candidate.id));
  }

  private fail(
    alias: string,
    previousModelId: string | null,
    newModelId: string,
    reason: string,
    provider: string,
  ): PromotionResult {
    modelPromotionFailureTotal.inc({ provider, family: 'unknown', reason: 'validation' });
    logger.warn('[model-promoter] Promotion rejected', {
      context: { alias, newModelId, reason },
    });
    return {
      success: false,
      alias,
      previousModelId,
      newModelId,
      validationError: reason,
    };
  }

  /** Test helper: reset internal state. */
  reset(): void {
    this.promotionLocks.clear();
  }
}

export const modelPromoter = new ModelPromoter();
