-- Model Registry — enforce uniqueness of (alias, candidate_model_id) (SQLite)
-- Up migration.
--
-- The original 0025 migration created a NON-unique index on
-- (alias, candidate_model_id). Deduplication relied on a read-then-write
-- check in ModelDiscovery (TOCTOU window) and the `catch` for a `unique`
-- error in registerCandidate was effectively dead code.
--
-- This migration replaces that index with a UNIQUE one, so the database
-- itself rejects duplicate candidates for the same alias and the catch
-- path becomes reachable.
--
-- MR-06: Safe migration with duplicate detection. If pre-existing
-- duplicates exist, the CREATE UNIQUE INDEX would fail after the DROP,
-- leaving the table without any index. We detect duplicates first and
-- keep only the latest row per (alias, candidate_model_id) before
-- creating the unique index.

-- Step 1: Detect and report duplicates (non-fatal; logs to stderr).
-- SQLite doesn't have RAISE NOTICE, so we just delete the duplicates.
-- Keep the row with the highest id (most recently inserted).
DELETE FROM model_candidates
WHERE id NOT IN (
  SELECT MAX(id) FROM model_candidates
  GROUP BY alias, candidate_model_id
);

-- Step 2: Drop the old non-unique index (if it exists).
DROP INDEX IF EXISTS idx_model_candidates_alias_candidate;

-- Step 3: Create the unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_candidates_alias_candidate
  ON model_candidates(alias, candidate_model_id);
