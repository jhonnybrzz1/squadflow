CREATE TABLE IF NOT EXISTS "document_jobs" (
  "job_id" text PRIMARY KEY NOT NULL,
  "demand_id" integer NOT NULL,
  "doc_type" text NOT NULL,
  "target_filepath" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "error" text,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_jobs_status_idx" ON "document_jobs" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_jobs_demand_idx" ON "document_jobs" ("demand_id", "doc_type");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "demand_id" integer NOT NULL,
  "speckit_path" text NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "prompt_sent_hash" text NOT NULL,
  "files_modified" text DEFAULT '[]' NOT NULL,
  "typecheck_passed" integer,
  "api_cost_usd" double precision,
  "human_edits_count" integer DEFAULT 0 NOT NULL,
  "cancelled_at" text,
  "error_message" text,
  "steps" text DEFAULT '[]' NOT NULL,
  "created_at" text DEFAULT (CURRENT_TIMESTAMP::text) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_jobs_demand_idx" ON "agent_jobs" ("demand_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_jobs_status_idx" ON "agent_jobs" ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "code_agent_job_queue" (
  "id" text PRIMARY KEY NOT NULL,
  "demand_id" integer NOT NULL,
  "speckit_path" text NOT NULL,
  "prompt" text NOT NULL,
  "cwd" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "error" text,
  "worker_pid" integer,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "code_agent_job_queue_status_idx" ON "code_agent_job_queue" ("status");
--> statement-breakpoint
-- Auditoria 2026-08-01 (A07): o ALTER abaixo pressupunha `retention_job_logs`,
-- mas nenhuma migration numerada criava a tabela (nem `retention_policies`, de
-- quem ela depende por FK) — a cadeia quebrava aqui com ON_ERROR_STOP=1 e um
-- PostgreSQL vazio não podia ser provisionado. Os CREATEs abaixo são idempotentes
-- e espelham `shared/schema-pg.ts` (retentionPolicies / retentionJobLogs).
CREATE TABLE IF NOT EXISTS "retention_policies" (
  "id" serial PRIMARY KEY NOT NULL,
  "data_type" text NOT NULL,
  "ttl_days" integer NOT NULL,
  "action" text DEFAULT 'delete' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "description" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retention_job_logs" (
  "id" serial PRIMARY KEY NOT NULL,
  "policy_id" integer NOT NULL REFERENCES "retention_policies"("id") ON DELETE CASCADE,
  "execution_started_at" timestamp DEFAULT now() NOT NULL,
  "execution_completed_at" timestamp,
  "status" text DEFAULT 'running' NOT NULL,
  "rows_affected" integer DEFAULT 0 NOT NULL,
  "db_size_before_mb" double precision,
  "db_size_after_mb" double precision,
  "error_message" text,
  "retry_attempt" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_retention_job_logs_policy_id" ON "retention_job_logs" ("policy_id");
--> statement-breakpoint
ALTER TABLE "retention_job_logs" ADD COLUMN IF NOT EXISTS "run_id" text;
