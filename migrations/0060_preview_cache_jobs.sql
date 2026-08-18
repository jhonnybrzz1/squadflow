-- Demanda #10366 — Fatia 2C: Preview Automático de Refinamento a partir do Repo GitHub.
-- Tabelas preview_cache (cache 24h) + preview_jobs (processamento assíncrono).

CREATE TABLE IF NOT EXISTS preview_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  result TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_preview_cache_user_repo ON preview_cache(user_id, owner, repo);

CREATE TABLE IF NOT EXISTS preview_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_preview_jobs_job_id ON preview_jobs(job_id);
