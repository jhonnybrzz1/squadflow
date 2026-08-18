-- Demanda 10025 — Pipeline Unificado de Refinamento (espelho PG da 0036 SQLite)

CREATE TABLE IF NOT EXISTS refinement_executions (
  id TEXT PRIMARY KEY,
  demand_id INTEGER NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
  adapter_fallback BOOLEAN NOT NULL DEFAULT FALSE,
  consensus_score DOUBLE PRECISION,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  execution_time_ms INTEGER NOT NULL,
  execution_phases JSONB,
  artifact_json JSONB,
  error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS refinement_executions_demand_idx ON refinement_executions (demand_id);
CREATE INDEX IF NOT EXISTS refinement_executions_method_idx ON refinement_executions (method);
CREATE INDEX IF NOT EXISTS refinement_executions_created_idx ON refinement_executions (created_at);
