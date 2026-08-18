-- Demanda #10365 — Fatia 2B: Acesso a Bases de Dados do Usuário para Refinamento.
-- Tabela `db_connections` — credenciais cifradas (AES-256-GCM), apenas leitura de schema.

CREATE TABLE IF NOT EXISTS db_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  db_type TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER,
  database_name TEXT,
  username TEXT,
  encrypted_credentials TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_db_connections_user_name ON db_connections(user_id, name);
CREATE INDEX IF NOT EXISTS idx_db_connections_user_id ON db_connections(user_id);
