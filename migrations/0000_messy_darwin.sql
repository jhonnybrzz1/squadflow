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
CREATE TABLE `agent_interventions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`demand_id` integer NOT NULL,
	`pontos_overengineering` text NOT NULL,
	`escopo_reduzido` text NOT NULL,
	`roi_estimado` text NOT NULL,
	`esforco_original_dias` real,
	`esforco_reduzido_dias` real,
	`override_applied` integer DEFAULT false NOT NULL,
	`override_by` text,
	`override_justification` text,
	`modelo` text,
	`criado_em` integer NOT NULL,
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
	`section_checklist` text DEFAULT '{}',
	`refinement_interactions` text DEFAULT '[]',
	`coverage_analysis` text,
	`learning_log` text DEFAULT '[]',
	`override_justification` text,
	`override_by` text,
	`run_id` text,
	`quality_gate_status` text,
	`final_doc_hash` text,
	`document_versions` text DEFAULT '{}',
	`max_effort_override_dias` real,
	`max_effort_override_by` text,
	`max_effort_override_justification` text,
	`repo_full_name` text,
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
CREATE TABLE `feedback_refinamento` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`refinement_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`nota` integer NOT NULL,
	`texto` text,
	`modelo` text,
	`qtd_iteracoes_ate_feedback` integer,
	`criado_em` integer NOT NULL
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
CREATE TABLE `human_feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`demand_id` integer NOT NULL,
	`agent_message_id` text NOT NULL,
	`feedback_text` text DEFAULT '' NOT NULL,
	`feedback_type` text NOT NULL,
	`agent` text,
	`created_at` integer NOT NULL
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
CREATE TABLE `retention_job_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`policy_id` integer NOT NULL,
	`execution_started_at` integer NOT NULL,
	`execution_completed_at` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`rows_affected` integer DEFAULT 0 NOT NULL,
	`db_size_before_mb` real,
	`db_size_after_mb` real,
	`error_message` text,
	`retry_attempt` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`policy_id`) REFERENCES `retention_policies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `retention_policies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`data_type` text NOT NULL,
	`ttl_days` integer NOT NULL,
	`action` text DEFAULT 'delete' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
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