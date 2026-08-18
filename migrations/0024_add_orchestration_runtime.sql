-- Orchestration Runtime Persistence (trilha de auditoria multiagente) — SQLite
-- Up migration.

CREATE TABLE IF NOT EXISTS orchestration_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  demand_id INTEGER NOT NULL,
  pipeline_id TEXT,
  mode TEXT NOT NULL DEFAULT 'sequential',
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'stopped')),
  agent_order TEXT,
  error_message TEXT,
  regulatory_context TEXT,
  sensitivity_level TEXT,
  norma_referencia TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_estimated REAL,
  metadata TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (demand_id) REFERENCES demands(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_turns (
  turn_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  demand_id INTEGER NOT NULL,
  agent_name TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
  error_message TEXT,
  duration_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_estimated REAL,
  metadata TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (run_id) REFERENCES orchestration_runs(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_tool_calls (
  tool_call_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
  args_json TEXT,
  result_json TEXT,
  error_message TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES agent_turns(turn_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orchestration_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  demand_id INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'ORCHESTRATION_STARTED',
    'AGENT_STARTED',
    'AGENT_COMPLETED',
    'AGENT_FAILED',
    'TOOL_CALL_COMPLETED',
    'TOOL_CALL_FAILED',
    'ROUNDTABLE_DIVERGENCE_RECORDED',
    'ORCHESTRATION_COMPLETED',
    'ORCHESTRATION_FAILED'
  )),
  agent_name TEXT,
  payload TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES orchestration_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_orchestration_runs_demand ON orchestration_runs(demand_id);
CREATE INDEX IF NOT EXISTS idx_agent_turns_run ON agent_turns(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_turn ON agent_tool_calls(turn_id);
CREATE INDEX IF NOT EXISTS idx_orchestration_events_run ON orchestration_events(run_id);
