-- Model Registry — dynamic model discovery & promotion (PostgreSQL)
-- Up migration. Safe for already-initialized environments (IF NOT EXISTS).

-- 8.1 Aliases ativos
CREATE TABLE IF NOT EXISTS model_aliases (
  id SERIAL PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  family TEXT NOT NULL,
  provider TEXT NOT NULL,
  active_model_id TEXT NOT NULL,
  fallback_model_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled', 'deprecated')),
  source TEXT NOT NULL DEFAULT 'static-fallback' CHECK(source IN ('memory-cache', 'database', 'static-fallback')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_validated_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_model_aliases_alias ON model_aliases(alias);
CREATE INDEX IF NOT EXISTS idx_model_aliases_provider ON model_aliases(provider);
CREATE INDEX IF NOT EXISTS idx_model_aliases_status ON model_aliases(status);

-- 8.2 Candidatos
CREATE TABLE IF NOT EXISTS model_candidates (
  id SERIAL PRIMARY KEY,
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
  evidence JSONB DEFAULT '{}'::jsonb,
  capabilities JSONB DEFAULT '{}'::jsonb,
  discovered_at TIMESTAMP NOT NULL DEFAULT NOW(),
  validated_at TIMESTAMP,
  validation_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_model_candidates_alias ON model_candidates(alias);
CREATE INDEX IF NOT EXISTS idx_model_candidates_provider ON model_candidates(provider);
CREATE INDEX IF NOT EXISTS idx_model_candidates_status ON model_candidates(status);
CREATE INDEX IF NOT EXISTS idx_model_candidates_discovered_at ON model_candidates(discovered_at);
CREATE INDEX IF NOT EXISTS idx_model_candidates_alias_candidate ON model_candidates(alias, candidate_model_id);

-- 8.3 Histórico
CREATE TABLE IF NOT EXISTS model_history (
  id SERIAL PRIMARY KEY,
  alias TEXT NOT NULL,
  previous_model_id TEXT,
  new_model_id TEXT,
  action TEXT NOT NULL CHECK(action IN (
    'promoted', 'rejected', 'rolled_back', 'auto_rolled_back',
    'invalidated', 'seeded'
  )),
  reason TEXT,
  triggered_by TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_model_history_alias ON model_history(alias);
CREATE INDEX IF NOT EXISTS idx_model_history_action ON model_history(action);
CREATE INDEX IF NOT EXISTS idx_model_history_created_at ON model_history(created_at);
