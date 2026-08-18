-- Demanda #10358 — Plataforma Online do Aichatflow para Vibe Coders (Fatia 1).
-- Camada pública multi-tenant, aditiva ao núcleo local-first (constituição v1.1.0).
-- Deliberadamente NÃO reaproveita a tabela legada `users` (server/storage.ts).

CREATE TABLE IF NOT EXISTS platform_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  session_nonce TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  source TEXT DEFAULT 'landing'
);

CREATE TABLE IF NOT EXISTS git_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'github',
  access_token_encrypted TEXT NOT NULL,
  github_username TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_git_connections_user_provider ON git_connections(user_id, provider);

CREATE TABLE IF NOT EXISTS usage_counters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  refinements_count INTEGER NOT NULL DEFAULT 0,
  connected_repos INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_counters_user_period ON usage_counters(user_id, period);

CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_user_event ON analytics_events(user_id, event_type);
