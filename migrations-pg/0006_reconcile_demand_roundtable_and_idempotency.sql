-- Reconcile Postgres runtime schema with shared/schema.ts.
-- Idempotent because existing Neon deployments may be on different migration baselines.

ALTER TABLE demands ADD COLUMN IF NOT EXISTS tdd_url TEXT;
ALTER TABLE demands ADD COLUMN IF NOT EXISTS mode TEXT DEFAULT 'sequential';
ALTER TABLE demands ADD COLUMN IF NOT EXISTS roundtable_config JSONB DEFAULT '{"agentIds":[],"maxRounds":3}'::jsonb;
ALTER TABLE demands ADD COLUMN IF NOT EXISTS roundtable_summary JSONB;

CREATE TABLE IF NOT EXISTS idempotency_records (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires_at
  ON idempotency_records(expires_at);
