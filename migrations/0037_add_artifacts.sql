-- Demanda 10037 — Artefatos Pós-Refinamento
-- Guarda o TEXTO-FONTE do artefato (diagrama Mermaid), não o binário
-- renderizado: por ADR-0002 a renderização acontece no cliente.
-- `source` já vem com PII mascarada pelo gerador. Append-only.

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  demand_id INTEGER NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS artifacts_demand_idx ON artifacts (demand_id);
CREATE INDEX IF NOT EXISTS artifacts_created_idx ON artifacts (created_at);
