-- Demanda 10037 — Artefatos Pós-Refinamento (espelho Postgres)
-- Ver migrations/0037_add_artifacts.sql e docs/adr/0002-render-mermaid-no-cliente.md

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  demand_id INTEGER NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS artifacts_demand_idx ON artifacts (demand_id);
CREATE INDEX IF NOT EXISTS artifacts_created_idx ON artifacts (created_at);
