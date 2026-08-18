-- Demanda 10025 — Pipeline Unificado de Refinamento
-- Trilha de auditoria por execução: método, fallback, score de consenso,
-- tokens, tempo, fases e artefato gerado. Append-only, sem tocar dados
-- existentes; demands.mode NÃO ganha 'unified' (decisão do spike T001).

CREATE TABLE IF NOT EXISTS refinement_executions (
  id TEXT PRIMARY KEY,
  demand_id INTEGER NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  fallback_used INTEGER NOT NULL DEFAULT 0,
  adapter_fallback INTEGER NOT NULL DEFAULT 0,
  consensus_score REAL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  execution_time_ms INTEGER NOT NULL,
  execution_phases TEXT,
  artifact_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS refinement_executions_demand_idx ON refinement_executions (demand_id);
CREATE INDEX IF NOT EXISTS refinement_executions_method_idx ON refinement_executions (method);
CREATE INDEX IF NOT EXISTS refinement_executions_created_idx ON refinement_executions (created_at);
