-- Orchestration Runtime Persistence (trilha de auditoria multiagente) — PostgreSQL
-- Up migration.

CREATE TABLE IF NOT EXISTS orchestration_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  demand_id INTEGER NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  pipeline_id TEXT,
  mode TEXT NOT NULL DEFAULT 'sequential',
  status TEXT NOT NULL,
  agent_order JSONB,
  error_message TEXT,
  regulatory_context TEXT,
  sensitivity_level TEXT,
  norma_referencia TEXT,
  tokens_in BIGINT,
  tokens_out BIGINT,
  cost_estimated DOUBLE PRECISION,
  metadata JSONB,
  started_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_turns (
  turn_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
  demand_id INTEGER NOT NULL,
  agent_name TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  duration_ms INTEGER,
  tokens_in BIGINT,
  tokens_out BIGINT,
  cost_estimated DOUBLE PRECISION,
  metadata JSONB,
  started_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_tool_calls (
  tool_call_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL REFERENCES agent_turns(turn_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  args_json JSONB,
  result_json JSONB,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS orchestration_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
  demand_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  agent_name TEXT,
  payload JSONB,
  created_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orchestration_runs_demand ON orchestration_runs(demand_id);
CREATE INDEX IF NOT EXISTS idx_agent_turns_run ON agent_turns(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_turn ON agent_tool_calls(turn_id);
CREATE INDEX IF NOT EXISTS idx_orchestration_events_run ON orchestration_events(run_id);
