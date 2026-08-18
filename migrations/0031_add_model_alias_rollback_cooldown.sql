-- Idempotent through scripts/audit-remediation-migrations.ts, which omits
-- individual ALTER statements when an upgraded SQLite database already has
-- the corresponding column.
BEGIN IMMEDIATE;

-- @if-column-missing model_aliases.failure_count
ALTER TABLE model_aliases ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
-- @if-column-missing model_aliases.last_failure_at
ALTER TABLE model_aliases ADD COLUMN last_failure_at INTEGER;
-- @if-column-missing model_aliases.last_rollback_at
ALTER TABLE model_aliases ADD COLUMN last_rollback_at INTEGER;

COMMIT;
