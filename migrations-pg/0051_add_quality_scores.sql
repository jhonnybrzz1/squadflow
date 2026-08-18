-- Demanda 10093 Fase 2 — Quality Index (espelho Postgres)
-- Persiste scores de groundedness, numeric-integrity e cited-path por demanda
-- e documento (PRD/TSD), permitindo análise de qualidade real no dashboard.

CREATE TABLE IF NOT EXISTS quality_scores (
  id TEXT PRIMARY KEY,
  demand_id INTEGER NOT NULL,
  document_type TEXT NOT NULL CHECK(document_type IN ('prd', 'tsd')),
  groundedness_score DOUBLE PRECISION,
  numeric_integrity_score DOUBLE PRECISION,
  cited_path_score DOUBLE PRECISION,
  overall_score DOUBLE PRECISION,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quality_scores_demand_id ON quality_scores(demand_id);
CREATE INDEX IF NOT EXISTS idx_quality_scores_document_type ON quality_scores(document_type);
