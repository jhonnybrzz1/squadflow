CREATE TABLE `agent_decision_records` (
	`run_id` text PRIMARY KEY NOT NULL,
	`demand_id` integer NOT NULL,
	`execution_id` text,
	`demand_type` text NOT NULL,
	`task_type` text NOT NULL,
	`problem_defined` integer,
	`ui_impact_known` text,
	`acceptance_scope` text NOT NULL,
	`confidence` text NOT NULL,
	`proposed_include_agents` text NOT NULL,
	`proposed_omit_agents` text NOT NULL,
	`actual_include_agents` text NOT NULL,
	`actual_omit_agents` text NOT NULL,
	`reason_codes` text NOT NULL,
	`fallback_used` integer NOT NULL,
	`shadow_mode` integer NOT NULL,
	`decision_latency_ms` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`demand_id`) REFERENCES `demands`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `approval_comments` (
	`comment_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`demand_id` integer NOT NULL,
	`review_snapshot_id` text,
	`approved_snapshot_id` text,
	`author` text,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`demand_id`) REFERENCES `demands`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `demands` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`type` text NOT NULL,
	`priority` text NOT NULL,
	`refinement_type` text,
	`status` text DEFAULT 'processing' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`chat_messages` text DEFAULT '[]',
	`prd_url` text,
	`tdd_url` text,
	`tasks_url` text,
	`domain` text DEFAULT 'padrao',
	`classification` text,
	`orchestration` text,
	`current_agent` text,
	`execution_id` text,
	`execution_config` text,
	`quality_passed` integer,
	`missing_sections` text,
	`fallback_used` integer DEFAULT false,
	`fallback_reason` text,
	`error_message` text,
	`validation_notes` text,
	`type_adherence` text,
	`completed_at` integer,
	`requires_approval` integer DEFAULT false,
	`requires_human_review` integer DEFAULT false,
	`document_state` text DEFAULT 'DRAFT',
	`review_snapshot_id` text,
	`approved_snapshot_id` text,
	`approved_snapshot_hash` text,
	`final_snapshot_id` text,
	`finalized_from_hash` text,
	`approval_session_id` text,
	`revision_number` integer DEFAULT 0 NOT NULL,
	`review_requested_at` integer,
	`approved_at` integer,
	`approved_by` text,
	`rejected_at` integer,
	`rejection_reason` text,
	`returned_to_draft_at` integer,
	`section_checklist` text DEFAULT '{}',
	`refinement_interactions` text DEFAULT '[]',
	`coverage_analysis` text,
	`learning_log` text DEFAULT '[]',
	`qa_evidence` text,
	`size` text,
	`override_justification` text,
	`override_by` text,
	`run_id` text,
	`quality_gate_status` text,
	`final_doc_hash` text,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`custo_estimado` real DEFAULT 0 NOT NULL,
	`document_versions` text DEFAULT '{}',
	`max_effort_override_dias` real,
	`max_effort_override_by` text,
	`max_effort_override_justification` text,
	`repo_full_name` text,
	`mode` text DEFAULT 'sequential',
	`roundtable_config` text DEFAULT '{"agentIds":[],"maxRounds":3}',
	`roundtable_summary` text,
	`skill_sh_url` text,
	`original_description` text,
	`go_live_mode` integer DEFAULT false,
	`origin` text,
	`origin_metadata` text DEFAULT '{}',
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `document_lifecycle_events` (
	`event_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`demand_id` integer NOT NULL,
	`requires_approval` integer NOT NULL,
	`approval_session_id` text,
	`event_type` text NOT NULL,
	`review_snapshot_id` text,
	`approved_snapshot_id` text,
	`final_snapshot_id` text,
	`finalized_from_hash` text,
	`result_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`demand_id`) REFERENCES `demands`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `document_snapshots` (
	`snapshot_id` text PRIMARY KEY NOT NULL,
	`demand_id` integer NOT NULL,
	`snapshot_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`demand_id`) REFERENCES `demands`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `domain_execution_records` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`demand_id` integer NOT NULL,
	`domain` text NOT NULL,
	`domain_triggered` integer NOT NULL,
	`domain_usable_returned` integer NOT NULL,
	`domain_used_in_final` integer NOT NULL,
	`output_source` text NOT NULL,
	`fallback_or_reprocess` integer NOT NULL,
	`latency_ms` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`demand_id`) REFERENCES `demands`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`demand_id` integer,
	`filename` text NOT NULL,
	`original_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`path` text NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`demand_id`) REFERENCES `demands`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `model_routing_stage_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`demand_id` integer NOT NULL,
	`execution_id` text,
	`stage_name` text NOT NULL,
	`model_used` text NOT NULL,
	`attempt_index` integer NOT NULL,
	`status` text NOT NULL,
	`validation_passed` integer,
	`validation_errors_count` integer,
	`qa_passed` integer,
	`qa_blockers_count` integer,
	`failure_reason` text,
	`final_artifact_accepted` integer,
	`metadata` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`demand_id`) REFERENCES `demands`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `operation_attempts` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`operation_type` text NOT NULL,
	`demand_id` integer,
	`status` text NOT NULL,
	`gate_status` text NOT NULL,
	`missing_fields` text NOT NULL,
	`error_code` text,
	`error_message` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`demand_id`) REFERENCES `demands`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `progressive_refinement_records` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`demand_id` integer NOT NULL,
	`complexity` text NOT NULL,
	`impact` text NOT NULL,
	`risk` text NOT NULL,
	`level_triaged` integer NOT NULL,
	`triage_confidence` integer DEFAULT 100 NOT NULL,
	`triage_reason_codes` text DEFAULT '[]',
	`level_executed` integer NOT NULL,
	`was_downgraded` integer DEFAULT false NOT NULL,
	`agents_used` text NOT NULL,
	`model_used` text NOT NULL,
	`calls_count_by_stage` text DEFAULT '{}',
	`context_budget_proxy_by_stage` text DEFAULT '{}',
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`cost_estimated` real DEFAULT 0 NOT NULL,
	`cost_real` real DEFAULT 0 NOT NULL,
	`rework_flag` integer DEFAULT false NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`incomplete` integer DEFAULT false NOT NULL,
	`artifact_validation` integer DEFAULT true NOT NULL,
	`gate_status` text NOT NULL,
	`ended_reason` text DEFAULT 'completed_successfully' NOT NULL,
	`experiment_bucket` text DEFAULT 'baseline' NOT NULL,
	`triage_policy_version` text DEFAULT '1.0.0' NOT NULL,
	`execution_policy_version` text DEFAULT '1.0.0' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`demand_id`) REFERENCES `demands`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `repo_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer,
	`path` text NOT NULL,
	`filename` text NOT NULL,
	`content` text,
	`language` text,
	`size` integer,
	`sha` text,
	`url` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`full_name` text NOT NULL,
	`description` text,
	`url` text NOT NULL,
	`clone_url` text,
	`ssh_url` text,
	`html_url` text,
	`default_branch` text,
	`language` text,
	`size` integer,
	`stars` integer DEFAULT 0,
	`forks` integer DEFAULT 0,
	`is_private` integer DEFAULT false,
	`is_fork` integer DEFAULT false,
	`indexed_content` text,
	`indexed_at` integer,
	`briefing` text,
	`briefing_generated_at` integer,
	`system_map` text,
	`system_map_generated_at` integer,
	`last_commit` text,
	`last_commit_date` integer,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_full_name_unique` ON `repos` (`full_name`);--> statement-breakpoint
CREATE TABLE `telemetry` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`demand_id` integer,
	`agent_name` text,
	`operation` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`retry_attempt` integer DEFAULT 0 NOT NULL,
	`fallback_used` integer DEFAULT false NOT NULL,
	`timestamp` integer NOT NULL,
	FOREIGN KEY (`demand_id`) REFERENCES `demands`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);
--> statement-breakpoint
-- H-9: FK indexes on demand_id for cascade delete performance (only for
-- tables that exist in this fixture — other tables get indexes via their
-- own migration files).
CREATE INDEX IF NOT EXISTS `idx_document_snapshots_demand_id` ON `document_snapshots` (`demand_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_approval_comments_demand_id` ON `approval_comments` (`demand_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_document_lifecycle_events_demand_id` ON `document_lifecycle_events` (`demand_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_operation_attempts_demand_id` ON `operation_attempts` (`demand_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_model_routing_stage_runs_demand_id` ON `model_routing_stage_runs` (`demand_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_decision_records_demand_id` ON `agent_decision_records` (`demand_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_domain_execution_records_demand_id` ON `domain_execution_records` (`demand_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_progressive_refinement_records_demand_id` ON `progressive_refinement_records` (`demand_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_files_demand_id` ON `files` (`demand_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_telemetry_demand_id` ON `telemetry` (`demand_id`);
