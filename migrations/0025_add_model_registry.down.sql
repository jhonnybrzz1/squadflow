-- Model Registry — down migration (SQLite)
-- Drops the model registry tables. Does NOT delete data from other tables.

DROP INDEX IF EXISTS idx_model_history_created_at;
DROP INDEX IF EXISTS idx_model_history_action;
DROP INDEX IF EXISTS idx_model_history_alias;
DROP TABLE IF EXISTS model_history;

DROP INDEX IF EXISTS idx_model_candidates_alias_candidate;
DROP INDEX IF EXISTS idx_model_candidates_discovered_at;
DROP INDEX IF EXISTS idx_model_candidates_status;
DROP INDEX IF EXISTS idx_model_candidates_provider;
DROP INDEX IF EXISTS idx_model_candidates_alias;
DROP TABLE IF EXISTS model_candidates;

DROP INDEX IF EXISTS idx_model_aliases_status;
DROP INDEX IF EXISTS idx_model_aliases_provider;
DROP INDEX IF EXISTS idx_model_aliases_alias;
DROP TABLE IF EXISTS model_aliases;
