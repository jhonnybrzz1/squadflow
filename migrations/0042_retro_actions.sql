-- Demanda 10092: evidência de execução (retrospectives) + ciclo de ações
-- (retro_actions). Tabelas NOVAS — não alteram retrospective_sessions (10078).
-- Criação também ocorre em runtime via retroActionsService.ensureSchema().
CREATE TABLE IF NOT EXISTS retrospectives (
  id TEXT PRIMARY KEY NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS retro_actions (
  id TEXT PRIMARY KEY NOT NULL,
  retro_id TEXT NOT NULL,
  description TEXT NOT NULL,
  owner TEXT,
  metric_key TEXT NOT NULL,
  metric_before REAL,
  metric_after REAL,
  success_criteria TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS retro_actions_retro_idx ON retro_actions(retro_id, created_at DESC);
