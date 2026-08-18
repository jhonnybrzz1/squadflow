-- Model Registry — revert UNIQUE on (alias, candidate_model_id) (PostgreSQL)
-- Down migration. Restores the original non-unique index from 0009.

DROP INDEX IF EXISTS idx_model_candidates_alias_candidate;
CREATE INDEX IF NOT EXISTS idx_model_candidates_alias_candidate
  ON model_candidates(alias, candidate_model_id);
