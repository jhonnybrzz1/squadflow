CREATE TABLE IF NOT EXISTS model_routing_stage_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  demand_id INTEGER NOT NULL,
  execution_id TEXT,
  stage_name TEXT NOT NULL,
  model_used TEXT NOT NULL,
  attempt_index INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed', 'fallback_triggered', 'failed_after_retries')),
  validation_passed INTEGER,
  validation_errors_count INTEGER,
  qa_passed INTEGER,
  qa_blockers_count INTEGER,
  failure_reason TEXT CHECK(failure_reason IN ('schema_failed', 'schema_parse_failed', 'validation_failed', 'qa_failed_critical', 'budget_exhausted')),
  final_artifact_accepted INTEGER,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (demand_id) REFERENCES demands(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_model_routing_stage_runs_demand_id ON model_routing_stage_runs(demand_id);
CREATE INDEX IF NOT EXISTS idx_model_routing_stage_runs_execution_id ON model_routing_stage_runs(execution_id);
CREATE INDEX IF NOT EXISTS idx_model_routing_stage_runs_stage_name ON model_routing_stage_runs(stage_name);
CREATE INDEX IF NOT EXISTS idx_model_routing_stage_runs_status ON model_routing_stage_runs(status);
