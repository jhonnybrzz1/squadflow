-- Prompt Versioning & A/B Testing tables

CREATE TABLE IF NOT EXISTS prompt_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_name TEXT NOT NULL,            -- agent name (e.g. "refinador")
  version TEXT NOT NULL,                -- version tag (e.g. "v1", "v2")
  content TEXT NOT NULL,                -- full YAML or system_prompt content
  is_active INTEGER NOT NULL DEFAULT 0, -- 1 = currently active version
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  activated_at INTEGER,
  author TEXT,                          -- who created this version
  description TEXT,                     -- changelog/description of changes
  UNIQUE(prompt_name, version)
);

CREATE INDEX IF NOT EXISTS idx_prompt_versions_name ON prompt_versions(prompt_name);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_active ON prompt_versions(prompt_name, is_active);

-- A/B test configuration
CREATE TABLE IF NOT EXISTS prompt_ab_tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_name TEXT NOT NULL,
  version_a TEXT NOT NULL,
  version_b TEXT NOT NULL,
  traffic_percent_b INTEGER NOT NULL DEFAULT 50, -- 0-100, percent routed to version B
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  ended_at INTEGER,
  UNIQUE(prompt_name, is_active)  -- only one active test per prompt
);

-- Metrics per interaction
CREATE TABLE IF NOT EXISTS prompt_version_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_name TEXT NOT NULL,
  version TEXT NOT NULL,
  session_id TEXT,
  demand_id INTEGER,
  success_flag INTEGER NOT NULL,       -- 1 = success, 0 = failure
  latency_ms INTEGER,
  ab_test_id INTEGER,                  -- NULL if not part of A/B test
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (ab_test_id) REFERENCES prompt_ab_tests(id)
);

CREATE INDEX IF NOT EXISTS idx_prompt_metrics_name_version ON prompt_version_metrics(prompt_name, version);
CREATE INDEX IF NOT EXISTS idx_prompt_metrics_ab_test ON prompt_version_metrics(ab_test_id);
CREATE INDEX IF NOT EXISTS idx_prompt_metrics_created ON prompt_version_metrics(created_at);
