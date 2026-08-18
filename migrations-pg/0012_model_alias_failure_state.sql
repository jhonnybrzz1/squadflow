-- MR-05: Persist auto-rollback failure count and last-failure timestamp on
-- model_aliases so they survive process restarts.
ALTER TABLE model_aliases ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_aliases ADD COLUMN last_failure_at TIMESTAMP;
