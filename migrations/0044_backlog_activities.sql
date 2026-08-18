-- Demanda 10096: backlog de atividades criadas automaticamente no handoff.
-- Tabela NOVA, separada de demands. Criação também em runtime via ensureSchema().
CREATE TABLE IF NOT EXISTS backlog_activities (
  id TEXT PRIMARY KEY NOT NULL,
  demand_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'em_desenvolvimento',
  has_prd INTEGER NOT NULL DEFAULT 0,
  has_tasks INTEGER NOT NULL DEFAULT 0,
  has_chat INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS backlog_activities_demand_idx ON backlog_activities(demand_id);
