-- H-9: Add foreign key indexes on demand_id columns.
--
-- 19 tables have a demand_id FK column but no index on it. deleteDemand()
-- runs 12+ DELETEs filtering by demand_id; without indexes, each does a
-- full table scan. This migration adds an index on demand_id for every
-- table that lacks one.
--
-- Index naming convention: idx_<table>_demand_id

CREATE INDEX IF NOT EXISTS idx_document_snapshots_demand_id ON document_snapshots(demand_id);
CREATE INDEX IF NOT EXISTS idx_approval_comments_demand_id ON approval_comments(demand_id);
CREATE INDEX IF NOT EXISTS idx_document_lifecycle_events_demand_id ON document_lifecycle_events(demand_id);
CREATE INDEX IF NOT EXISTS idx_operation_attempts_demand_id ON operation_attempts(demand_id);
CREATE INDEX IF NOT EXISTS idx_model_routing_stage_runs_demand_id ON model_routing_stage_runs(demand_id);
CREATE INDEX IF NOT EXISTS idx_agent_decision_records_demand_id ON agent_decision_records(demand_id);
CREATE INDEX IF NOT EXISTS idx_domain_execution_records_demand_id ON domain_execution_records(demand_id);
CREATE INDEX IF NOT EXISTS idx_progressive_refinement_records_demand_id ON progressive_refinement_records(demand_id);
CREATE INDEX IF NOT EXISTS idx_orchestration_runs_demand_id ON orchestration_runs(demand_id);
CREATE INDEX IF NOT EXISTS idx_agent_turns_demand_id ON agent_turns(demand_id);
CREATE INDEX IF NOT EXISTS idx_orchestration_events_demand_id ON orchestration_events(demand_id);
CREATE INDEX IF NOT EXISTS idx_files_demand_id ON files(demand_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_demand_id ON telemetry(demand_id);
CREATE INDEX IF NOT EXISTS idx_human_feedback_demand_id ON human_feedback(demand_id);
CREATE INDEX IF NOT EXISTS idx_agent_interventions_demand_id ON agent_interventions(demand_id);
CREATE INDEX IF NOT EXISTS idx_code_agent_job_queue_demand_id ON code_agent_job_queue(demand_id);
CREATE INDEX IF NOT EXISTS idx_refinement_executions_demand_id ON refinement_executions(demand_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_demand_id ON artifacts(demand_id);
CREATE INDEX IF NOT EXISTS idx_demand_external_docs_demand_id ON demand_external_docs(demand_id);
