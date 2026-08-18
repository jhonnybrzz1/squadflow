-- Reconcile a partially migrated Neon database with the application schema.
-- This migration is intentionally idempotent and avoids adding foreign keys to
-- pre-existing telemetry tables because their historical demand_id values may
-- not exist in a newly created demands table.

CREATE TABLE IF NOT EXISTS "demands" (
  "id" serial PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "type" text NOT NULL,
  "priority" text NOT NULL,
  "refinement_type" text,
  "status" text DEFAULT 'processing' NOT NULL,
  "progress" integer DEFAULT 0 NOT NULL,
  "chat_messages" jsonb DEFAULT '[]'::jsonb,
  "prd_url" text,
  "tasks_url" text,
  "classification" jsonb,
  "orchestration" jsonb,
  "current_agent" text,
  "error_message" text,
  "validation_notes" text,
  "type_adherence" jsonb,
  "completed_at" timestamp,
  "requires_approval" boolean DEFAULT false,
  "requires_human_review" boolean DEFAULT false,
  "document_state" text DEFAULT 'DRAFT',
  "review_snapshot_id" text,
  "approved_snapshot_id" text,
  "approved_snapshot_hash" text,
  "final_snapshot_id" text,
  "finalized_from_hash" text,
  "approval_session_id" text,
  "revision_number" integer DEFAULT 0 NOT NULL,
  "review_requested_at" timestamp,
  "approved_at" timestamp,
  "section_checklist" jsonb DEFAULT '{}'::jsonb,
  "refinement_interactions" jsonb DEFAULT '[]'::jsonb,
  "coverage_analysis" jsonb,
  "learning_log" jsonb DEFAULT '[]'::jsonb,
  "override_justification" text,
  "override_by" text,
  "run_id" text,
  "quality_gate_status" text,
  "final_doc_hash" text,
  "document_versions" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now(),
  "domain" text DEFAULT 'padrao',
  "execution_id" text,
  "execution_config" jsonb,
  "quality_passed" boolean,
  "missing_sections" jsonb,
  "fallback_used" boolean DEFAULT false,
  "fallback_reason" text
);

CREATE TABLE IF NOT EXISTS "document_snapshots" (
  "snapshot_id" text PRIMARY KEY NOT NULL,
  "demand_id" integer NOT NULL,
  "snapshot_type" text NOT NULL,
  "payload_json" text NOT NULL,
  "snapshot_hash" text NOT NULL,
  "created_at" timestamp NOT NULL
);

CREATE TABLE IF NOT EXISTS "approval_comments" (
  "comment_id" serial PRIMARY KEY NOT NULL,
  "demand_id" integer NOT NULL,
  "review_snapshot_id" text,
  "approved_snapshot_id" text,
  "author" text,
  "content" text NOT NULL,
  "created_at" timestamp NOT NULL
);

CREATE TABLE IF NOT EXISTS "document_lifecycle_events" (
  "event_id" serial PRIMARY KEY NOT NULL,
  "demand_id" integer NOT NULL,
  "requires_approval" boolean NOT NULL,
  "approval_session_id" text,
  "event_type" text NOT NULL,
  "review_snapshot_id" text,
  "approved_snapshot_id" text,
  "final_snapshot_id" text,
  "finalized_from_hash" text,
  "result_code" text,
  "error_message" text,
  "created_at" timestamp NOT NULL
);

CREATE TABLE IF NOT EXISTS "operation_attempts" (
  "attempt_id" text PRIMARY KEY NOT NULL,
  "operation_id" text NOT NULL,
  "operation_type" text NOT NULL,
  "demand_id" integer,
  "status" text NOT NULL,
  "gate_status" text NOT NULL,
  "missing_fields" jsonb NOT NULL,
  "error_code" text,
  "error_message" text,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL,
  "updated_at" timestamp NOT NULL,
  "completed_at" timestamp
);

CREATE TABLE IF NOT EXISTS "progressive_refinement_records" (
  "execution_id" text PRIMARY KEY NOT NULL,
  "demand_id" integer NOT NULL,
  "complexity" text NOT NULL,
  "impact" text NOT NULL,
  "risk" text NOT NULL,
  "level_triaged" integer NOT NULL,
  "triage_confidence" integer DEFAULT 100 NOT NULL,
  "triage_reason_codes" jsonb DEFAULT '[]'::jsonb,
  "level_executed" integer NOT NULL,
  "was_downgraded" boolean DEFAULT false NOT NULL,
  "agents_used" jsonb NOT NULL,
  "model_used" text NOT NULL,
  "calls_count_by_stage" jsonb DEFAULT '{}'::jsonb,
  "context_budget_proxy_by_stage" jsonb DEFAULT '{}'::jsonb,
  "tokens_in" bigint DEFAULT 0 NOT NULL,
  "tokens_out" bigint DEFAULT 0 NOT NULL,
  "cost_estimated" double precision DEFAULT 0 NOT NULL,
  "cost_real" double precision DEFAULT 0 NOT NULL,
  "rework_flag" boolean DEFAULT false NOT NULL,
  "truncated" boolean DEFAULT false NOT NULL,
  "incomplete" boolean DEFAULT false NOT NULL,
  "artifact_validation" boolean DEFAULT true NOT NULL,
  "gate_status" text NOT NULL,
  "ended_reason" text DEFAULT 'completed_successfully' NOT NULL,
  "experiment_bucket" text DEFAULT 'baseline' NOT NULL,
  "triage_policy_version" text DEFAULT '1.0.0' NOT NULL,
  "execution_policy_version" text DEFAULT '1.0.0' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "files" (
  "id" serial PRIMARY KEY NOT NULL,
  "demand_id" integer,
  "filename" text NOT NULL,
  "original_name" text NOT NULL,
  "mime_type" text NOT NULL,
  "size" integer NOT NULL,
  "path" text NOT NULL,
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "users" (
  "id" serial PRIMARY KEY NOT NULL,
  "username" text NOT NULL UNIQUE,
  "password" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "telemetry" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "demand_id" integer,
  "agent_name" text,
  "operation" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "tokens_in" integer DEFAULT 0 NOT NULL,
  "tokens_out" integer DEFAULT 0 NOT NULL,
  "latency_ms" integer DEFAULT 0 NOT NULL,
  "status" text NOT NULL,
  "retry_attempt" integer DEFAULT 0 NOT NULL,
  "fallback_used" boolean DEFAULT false NOT NULL,
  "timestamp" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE agent_decision_records
  ALTER COLUMN created_at DROP DEFAULT;

DO $$
DECLARE
  col_name text;
BEGIN
  FOREACH col_name IN ARRAY ARRAY[
    'proposed_include_agents',
    'proposed_omit_agents',
    'actual_include_agents',
    'actual_omit_agents',
    'reason_codes'
  ]
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'agent_decision_records'
        AND column_name = col_name
        AND data_type <> 'jsonb'
    ) THEN
      EXECUTE format(
        'ALTER TABLE agent_decision_records ALTER COLUMN %I TYPE jsonb USING %I::jsonb',
        col_name,
        col_name
      );
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'model_routing_stage_runs'
      AND column_name = 'metadata'
      AND data_type <> 'jsonb'
  ) THEN
    ALTER TABLE model_routing_stage_runs
      ALTER COLUMN metadata TYPE jsonb USING metadata::jsonb;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_model_routing_stage_runs_demand_id
  ON model_routing_stage_runs(demand_id);
CREATE INDEX IF NOT EXISTS idx_model_routing_stage_runs_execution_id
  ON model_routing_stage_runs(execution_id);
CREATE INDEX IF NOT EXISTS idx_model_routing_stage_runs_stage_name
  ON model_routing_stage_runs(stage_name);
CREATE INDEX IF NOT EXISTS idx_model_routing_stage_runs_status
  ON model_routing_stage_runs(status);
CREATE INDEX IF NOT EXISTS idx_agent_decision_records_demand_id
  ON agent_decision_records(demand_id);
CREATE INDEX IF NOT EXISTS idx_agent_decision_records_execution_id
  ON agent_decision_records(execution_id);
CREATE INDEX IF NOT EXISTS idx_domain_execution_records_demand_id
  ON domain_execution_records(demand_id);
CREATE INDEX IF NOT EXISTS idx_domain_execution_records_domain
  ON domain_execution_records(domain);
