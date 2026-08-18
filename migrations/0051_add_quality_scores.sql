-- Demanda 10093 Fase 2 — Quality Index
-- Persiste scores de groundedness, numeric-integrity e cited-path por demanda
-- e documento (PRD/TSD), permitindo análise de qualidade real no dashboard.

CREATE TABLE IF NOT EXISTS quality_scores (
  id TEXT PRIMARY KEY NOT NULL,
  demand_id INTEGER NOT NULL,
  document_type TEXT NOT NULL CHECK(document_type IN ('prd', 'tsd')),
  groundedness_score REAL,
  numeric_integrity_score REAL,
  cited_path_score REAL,
  overall_score REAL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quality_scores_demand_id ON quality_scores(demand_id);
CREATE INDEX IF NOT EXISTS idx_quality_scores_document_type ON quality_scores(document_type);
