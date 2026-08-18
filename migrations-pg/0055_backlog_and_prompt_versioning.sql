-- Auditoria 2026-08-01 (A08 / demanda #10289): estas 4 tabelas existiam em
-- `shared/schema-pg.ts` e tinham migration SQLite (0012, 0044), mas NENHUMA
-- migration PostgreSQL. No perfil PG elas simplesmente não existiam: o
-- versionamento de prompt caía para filesystem e o backlog pós-handoff falhava
-- em silêncio, porque `ensureSchema()` desses serviços retorna cedo quando
-- `isPostgres` é true.
--
-- Definições espelham o schema Drizzle (fonte da verdade), não o SQL SQLite:
-- booleanos são BOOLEAN nativo (não 0/1) e os `created_at` de prompt seguem o
-- default declarado no schema (epoch em INTEGER).

CREATE TABLE IF NOT EXISTS "backlog_activities" (
  "id" text PRIMARY KEY NOT NULL,
  "demand_id" integer NOT NULL,
  "title" text NOT NULL,
  "status" text DEFAULT 'em_desenvolvimento' NOT NULL,
  "has_prd" boolean DEFAULT false NOT NULL,
  "has_tasks" boolean DEFAULT false NOT NULL,
  "has_chat" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Um handoff por demanda: o evento reemitir não duplica a atividade.
CREATE UNIQUE INDEX IF NOT EXISTS "backlog_activities_demand_idx"
  ON "backlog_activities" ("demand_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "prompt_versions" (
  "id" serial PRIMARY KEY NOT NULL,
  "prompt_name" text NOT NULL,
  "version" text NOT NULL,
  "content" text NOT NULL,
  "is_active" boolean DEFAULT false NOT NULL,
  "created_at" integer DEFAULT EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::int NOT NULL,
  "activated_at" integer,
  "author" text,
  "description" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_prompt_versions_name_version"
  ON "prompt_versions" ("prompt_name", "version");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "prompt_ab_tests" (
  "id" serial PRIMARY KEY NOT NULL,
  "prompt_name" text NOT NULL,
  "version_a" text NOT NULL,
  "version_b" text NOT NULL,
  "traffic_percent_b" integer DEFAULT 50 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" integer DEFAULT EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::int NOT NULL,
  "ended_at" integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_prompt_ab_tests_name_active"
  ON "prompt_ab_tests" ("prompt_name", "is_active");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "prompt_version_metrics" (
  "id" serial PRIMARY KEY NOT NULL,
  "prompt_name" text NOT NULL,
  "version" text NOT NULL,
  "session_id" text,
  "demand_id" integer,
  -- `model` não estava em shared/schema-pg.ts nem em shared/schema.ts, mas o
  -- serviço INSERT/SELECT nessa coluna (prompt-version.ts:513,549) e o DDL de
  -- runtime a criava. A declaração Drizzle é que estava desatualizada.
  "model" text,
  "success_flag" boolean NOT NULL,
  "latency_ms" integer,
  "ab_test_id" integer REFERENCES "prompt_ab_tests"("id"),
  "created_at" integer DEFAULT EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::int NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_prompt_metrics_name_version"
  ON "prompt_version_metrics" ("prompt_name", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_prompt_metrics_ab_test"
  ON "prompt_version_metrics" ("ab_test_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_prompt_metrics_created"
  ON "prompt_version_metrics" ("created_at");
