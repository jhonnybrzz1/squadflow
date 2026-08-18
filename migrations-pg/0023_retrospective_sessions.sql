CREATE TABLE IF NOT EXISTS "retrospective_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "period_start" text NOT NULL,
  "period_end" text NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "summary" text,
  "insights" text DEFAULT '[]' NOT NULL,
  "demands_analyzed" text DEFAULT '[]' NOT NULL,
  "agent_participants" text DEFAULT '[]' NOT NULL,
  "error_message" text,
  "started_at" text DEFAULT (CURRENT_TIMESTAMP::text) NOT NULL,
  "completed_at" text,
  "created_at" text DEFAULT (CURRENT_TIMESTAMP::text) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retrospective_sessions_status_idx" ON "retrospective_sessions" ("status");
