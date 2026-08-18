CREATE TABLE "agent_decision_records" (
	"run_id" text PRIMARY KEY NOT NULL,
	"demand_id" integer NOT NULL,
	"execution_id" text,
	"demand_type" text NOT NULL,
	"task_type" text NOT NULL,
	"problem_defined" integer,
	"ui_impact_known" text,
	"acceptance_scope" text NOT NULL,
	"confidence" text NOT NULL,
	"proposed_include_agents" jsonb NOT NULL,
	"proposed_omit_agents" jsonb NOT NULL,
	"actual_include_agents" jsonb NOT NULL,
	"actual_omit_agents" jsonb NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"fallback_used" integer NOT NULL,
	"shadow_mode" integer NOT NULL,
	"decision_latency_ms" integer NOT NULL,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_comments" (
	"comment_id" serial PRIMARY KEY NOT NULL,
	"demand_id" integer NOT NULL,
	"review_snapshot_id" text,
	"approved_snapshot_id" text,
	"author" text,
	"content" text NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demands" (
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
--> statement-breakpoint
CREATE TABLE "document_lifecycle_events" (
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
--> statement-breakpoint
CREATE TABLE "document_snapshots" (
	"snapshot_id" text PRIMARY KEY NOT NULL,
	"demand_id" integer NOT NULL,
	"snapshot_type" text NOT NULL,
	"payload_json" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_execution_records" (
	"execution_id" text PRIMARY KEY NOT NULL,
	"demand_id" integer NOT NULL,
	"domain" text NOT NULL,
	"domain_triggered" integer NOT NULL,
	"domain_usable_returned" integer NOT NULL,
	"domain_used_in_final" integer NOT NULL,
	"output_source" text NOT NULL,
	"fallback_or_reprocess" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" serial PRIMARY KEY NOT NULL,
	"demand_id" integer,
	"filename" text NOT NULL,
	"original_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "model_routing_stage_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"demand_id" integer NOT NULL,
	"execution_id" text,
	"stage_name" text NOT NULL,
	"model_used" text NOT NULL,
	"attempt_index" integer NOT NULL,
	"status" text NOT NULL,
	"validation_passed" integer,
	"validation_errors_count" integer,
	"qa_passed" integer,
	"qa_blockers_count" integer,
	"failure_reason" text,
	"final_artifact_accepted" integer,
	"metadata" jsonb,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operation_attempts" (
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
--> statement-breakpoint
CREATE TABLE "progressive_refinement_records" (
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
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
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
--> statement-breakpoint
CREATE TABLE "repo_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" integer,
	"path" text NOT NULL,
	"filename" text NOT NULL,
	"content" text,
	"language" text,
	"size" integer,
	"sha" text,
	"url" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"description" text,
	"url" text NOT NULL,
	"clone_url" text,
	"ssh_url" text,
	"html_url" text,
	"default_branch" text,
	"language" text,
	"size" integer,
	"stars" integer DEFAULT 0,
	"forks" integer DEFAULT 0,
	"is_private" boolean DEFAULT false,
	"is_fork" boolean DEFAULT false,
	"indexed_content" text,
	"indexed_at" timestamp,
	"briefing" text,
	"briefing_generated_at" timestamp,
	"system_map" text,
	"system_map_generated_at" timestamp,
	"last_commit" text,
	"last_commit_date" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "repos_full_name_unique" UNIQUE("full_name")
);
--> statement-breakpoint
CREATE TABLE "telemetry" (
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
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password" text NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "agent_decision_records" ADD CONSTRAINT "agent_decision_records_demand_id_demands_id_fk" FOREIGN KEY ("demand_id") REFERENCES "public"."demands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_comments" ADD CONSTRAINT "approval_comments_demand_id_demands_id_fk" FOREIGN KEY ("demand_id") REFERENCES "public"."demands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lifecycle_events" ADD CONSTRAINT "document_lifecycle_events_demand_id_demands_id_fk" FOREIGN KEY ("demand_id") REFERENCES "public"."demands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_snapshots" ADD CONSTRAINT "document_snapshots_demand_id_demands_id_fk" FOREIGN KEY ("demand_id") REFERENCES "public"."demands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_execution_records" ADD CONSTRAINT "domain_execution_records_demand_id_demands_id_fk" FOREIGN KEY ("demand_id") REFERENCES "public"."demands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_demand_id_demands_id_fk" FOREIGN KEY ("demand_id") REFERENCES "public"."demands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_routing_stage_runs" ADD CONSTRAINT "model_routing_stage_runs_demand_id_demands_id_fk" FOREIGN KEY ("demand_id") REFERENCES "public"."demands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_attempts" ADD CONSTRAINT "operation_attempts_demand_id_demands_id_fk" FOREIGN KEY ("demand_id") REFERENCES "public"."demands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progressive_refinement_records" ADD CONSTRAINT "progressive_refinement_records_demand_id_demands_id_fk" FOREIGN KEY ("demand_id") REFERENCES "public"."demands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_files" ADD CONSTRAINT "repo_files_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry" ADD CONSTRAINT "telemetry_demand_id_demands_id_fk" FOREIGN KEY ("demand_id") REFERENCES "public"."demands"("id") ON DELETE no action ON UPDATE no action;