-- Model Registry — dynamic model discovery & promotion (SQLite)
-- Up migration. Safe for already-initialized environments (IF NOT EXISTS).

-- 8.1 Aliases ativos
CREATE TABLE IF NOT EXISTS model_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias TEXT NOT NULL UNIQUE,
  family TEXT NOT NULL,
  provider TEXT NOT NULL,
  active_model_id TEXT NOT NULL,
  fallback_model_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled', 'deprecated')),
  source TEXT NOT NULL DEFAULT 'static-fallback' CHECK(source IN ('memory-cache', 'database', 'static-fallback')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_validated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_model_aliases_alias ON model_aliases(alias);
CREATE INDEX IF NOT EXISTS idx_model_aliases_provider ON model_aliases(provider);
CREATE INDEX IF NOT EXISTS idx_model_aliases_status ON model_aliases(status);

-- 8.2 Candidatos
CREATE TABLE IF NOT EXISTS model_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias TEXT NOT NULL,
  family TEXT NOT NULL,
  provider TEXT NOT NULL,
  current_model_id TEXT NOT NULL,
  candidate_model_id TEXT NOT NULL,
  candidate_version TEXT,
  status TEXT NOT NULL DEFAULT 'discovered' CHECK(status IN (
    'discovered', 'validating', 'validated', 'validation_failed',
    'promoted', 'rejected', 'superseded'
  )),
  selection_reason TEXT,
  evidence TEXT DEFAULT '{}',
  capabilities TEXT DEFAULT '{}',
  discovered_at INTEGER NOT NULL,
  validated_at INTEGER,
  validation_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_model_candidates_alias ON model_candidates(alias);
CREATE INDEX IF NOT EXISTS idx_model_candidates_provider ON model_candidates(provider);
CREATE INDEX IF NOT EXISTS idx_model_candidates_status ON model_candidates(status);
CREATE INDEX IF NOT EXISTS idx_model_candidates_discovered_at ON model_candidates(discovered_at);
CREATE INDEX IF NOT EXISTS idx_model_candidates_alias_candidate ON model_candidates(alias, candidate_model_id);

-- 8.3 Histórico
CREATE TABLE IF NOT EXISTS model_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias TEXT NOT NULL,
  previous_model_id TEXT,
  new_model_id TEXT,
  action TEXT NOT NULL CHECK(action IN (
    'promoted', 'rejected', 'rolled_back', 'auto_rolled_back',
    'invalidated', 'seeded'
  )),
  reason TEXT,
  triggered_by TEXT NOT NULL DEFAULT 'system',
  created_at INTEGER NOT NULL,
  metadata TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_model_history_alias ON model_history(alias);
CREATE INDEX IF NOT EXISTS idx_model_history_action ON model_history(action);
CREATE INDEX IF NOT EXISTS idx_model_history_created_at ON model_history(created_at);
