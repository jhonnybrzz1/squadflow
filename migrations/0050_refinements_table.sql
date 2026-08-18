-- Migration #10048: tabela de refinamentos para persistência de dados brutos
-- e visualização no Grafana.

CREATE TABLE IF NOT EXISTS refinements (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT NOT NULL,
  metadata TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refinements_session_id ON refinements(session_id);
CREATE INDEX IF NOT EXISTS idx_refinements_created_at ON refinements(created_at);
