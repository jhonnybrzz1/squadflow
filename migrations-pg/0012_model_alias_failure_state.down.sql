-- MR-05: Reverse the failure-state columns.
ALTER TABLE model_aliases DROP COLUMN IF EXISTS last_failure_at;
ALTER TABLE model_aliases DROP COLUMN IF EXISTS failure_count;
