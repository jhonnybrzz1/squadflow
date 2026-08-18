CREATE TABLE IF NOT EXISTS `document_jobs` (
  `job_id` text PRIMARY KEY NOT NULL,
  `demand_id` integer NOT NULL,
  `doc_type` text NOT NULL,
  `target_filepath` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `document_jobs_status_idx` ON `document_jobs` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `document_jobs_demand_idx` ON `document_jobs` (`demand_id`, `doc_type`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `demand_id` integer NOT NULL,
  `speckit_path` text NOT NULL,
  `status` text DEFAULT 'running' NOT NULL,
  `prompt_sent_hash` text NOT NULL,
  `files_modified` text DEFAULT '[]' NOT NULL,
  `typecheck_passed` integer,
  `api_cost_usd` real,
  `human_edits_count` integer DEFAULT 0 NOT NULL,
  `cancelled_at` text,
  `error_message` text,
  `steps` text DEFAULT '[]' NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_jobs_demand_idx` ON `agent_jobs` (`demand_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_jobs_status_idx` ON `agent_jobs` (`status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `code_agent_job_queue` (
  `id` text PRIMARY KEY NOT NULL,
  `demand_id` integer NOT NULL,
  `speckit_path` text NOT NULL,
  `prompt` text NOT NULL,
  `cwd` text,
  `status` text DEFAULT 'pending' NOT NULL,
  `error` text,
  `worker_pid` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `code_agent_job_queue_status_idx` ON `code_agent_job_queue` (`status`);
--> statement-breakpoint
ALTER TABLE `retention_job_logs` ADD COLUMN `run_id` text;
