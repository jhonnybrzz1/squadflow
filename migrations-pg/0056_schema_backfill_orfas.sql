-- Auditoria 2026-08-01 (A07 / demanda #10288) — backfill das tabelas declaradas
-- em `shared/schema-pg.ts` que nunca tiveram migration PostgreSQL.
--
-- Elas existiam só como declaração Drizzle e eram criadas em runtime por
-- `ensureSchema`/DDL espalhado, quando eram criadas. Num PostgreSQL provisionado
-- pela cadeia de migrations, simplesmente não existiam — o schema dependia de
-- efeito colateral de boot.
--
-- O DDL abaixo foi DERIVADO dos objetos Drizzle via `getTableConfig`, não
-- escrito à mão nem copiado do SQLite: tipos, defaults, PKs, FKs e índices vêm
-- da mesma fonte que o runtime usa.
--
-- EXCLUÍDA de propósito: `chunk_embeddings`. Ela declara `vector(3072)`, que
-- exige a extensão pgvector — e nenhuma migration da cadeia faz
-- `CREATE EXTENSION vector`, nem a imagem do pg-smoke (postgres:16-alpine) a
-- possui. Além disso `chunkEmbeddings` não tem nenhum uso em `server/` fora do
-- schema. Criá-la aqui quebraria o provisionamento do zero para habilitar uma
-- tabela que ninguém lê. Fica registrada como pendência de infraestrutura.

CREATE TABLE IF NOT EXISTS "agent_interventions" (
  "id" serial PRIMARY KEY,
  "demand_id" integer NOT NULL,
  "pontos_overengineering" jsonb NOT NULL,
  "escopo_reduzido" text NOT NULL,
  "roi_estimado" text NOT NULL,
  "esforco_original_dias" double precision,
  "esforco_reduzido_dias" double precision,
  "override_applied" boolean NOT NULL DEFAULT false,
  "override_by" text,
  "override_justification" text,
  "modelo" text,
  "criado_em" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_memory" (
  "id" text PRIMARY KEY,
  "agent_id" text NOT NULL,
  "memory_type" text NOT NULL,
  "content" text NOT NULL,
  "source_demand_id" integer,
  "created_at" timestamp NOT NULL
);
CREATE INDEX IF NOT EXISTS "agent_memory_lookup_idx" ON "agent_memory" ("agent_id", "memory_type", "created_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chunk_relevance_scores" (
  "chunk_id" text NOT NULL,
  "chunk_source" text NOT NULL DEFAULT 'comex_cambio',
  "total_shown" integer DEFAULT 0,
  "total_helpful" integer DEFAULT 0,
  "total_selected" integer DEFAULT 0,
  "success_rate" double precision DEFAULT 0,
  "boost_factor" double precision DEFAULT 1,
  "updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_errors" (
  "id" serial PRIMARY KEY,
  "timestamp" timestamp NOT NULL,
  "session_id" text NOT NULL,
  "component" text NOT NULL,
  "error_message" text NOT NULL,
  "stack_trace" text DEFAULT '',
  "payload" jsonb,
  "data_source" text NOT NULL,
  "user_agent" text DEFAULT '',
  "url" text DEFAULT ''
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "episodic_memory" (
  "id" text PRIMARY KEY,
  "skill" text NOT NULL,
  "content" text NOT NULL,
  "confidence" double precision NOT NULL DEFAULT 0,
  "sanitized" boolean NOT NULL DEFAULT false,
  "source_type" text NOT NULL DEFAULT 'episodic',
  "retry_count" integer,
  "duration_ms" integer,
  "memory_active" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL
);
CREATE INDEX IF NOT EXISTS "episodic_memory_skill_idx" ON "episodic_memory" ("skill", "confidence" DESC, "created_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "guardrail_logs" (
  "id" serial PRIMARY KEY,
  "timestamp" integer NOT NULL,
  "guardrail_type" text NOT NULL,
  "action" text NOT NULL,
  "reason" text,
  "input_hash" text NOT NULL,
  "detections" jsonb NOT NULL,
  "latency_ms" integer NOT NULL DEFAULT 0,
  "user_id" text,
  "demand_id" integer,
  "request_id" text
);
CREATE INDEX IF NOT EXISTS "idx_guardrail_logs_timestamp" ON "guardrail_logs" ("timestamp");
CREATE INDEX IF NOT EXISTS "idx_guardrail_logs_type" ON "guardrail_logs" ("guardrail_type");
CREATE INDEX IF NOT EXISTS "idx_guardrail_logs_action" ON "guardrail_logs" ("action");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "human_feedback" (
  "id" serial PRIMARY KEY,
  "demand_id" integer NOT NULL,
  "agent_message_id" text NOT NULL,
  "feedback_text" text NOT NULL DEFAULT '',
  "feedback_type" text NOT NULL,
  "agent" text,
  "created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_audit_logs" (
  "id" serial PRIMARY KEY,
  "request_id" text NOT NULL,
  "user_id" text,
  "user_name" text,
  "prompt" text NOT NULL,
  "response" text NOT NULL,
  "model" text NOT NULL,
  "provider" text NOT NULL,
  "operation" text,
  "agent_name" text,
  "latency_ms" integer NOT NULL DEFAULT 0,
  "status_code" integer NOT NULL DEFAULT 200,
  "error_message" text,
  "prompt_tokens" integer NOT NULL DEFAULT 0,
  "completion_tokens" integer NOT NULL DEFAULT 0,
  "total_tokens" integer NOT NULL DEFAULT 0,
  "estimated_cost_usd" double precision,
  "duimp_id" text,
  "contract_id" text,
  "ncm" text,
  "iof_flag" boolean DEFAULT false,
  "domain" text DEFAULT 'geral',
  "demand_id" integer,
  "feedback" text,
  "feedback_comment" text,
  "feedback_at" integer,
  "created_at" integer NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_llm_audit_logs_created_at" ON "llm_audit_logs" ("created_at");
CREATE INDEX IF NOT EXISTS "idx_llm_audit_logs_duimp_id" ON "llm_audit_logs" ("duimp_id");
CREATE INDEX IF NOT EXISTS "idx_llm_audit_logs_contract_id" ON "llm_audit_logs" ("contract_id");
CREATE INDEX IF NOT EXISTS "idx_llm_audit_logs_ncm" ON "llm_audit_logs" ("ncm");
CREATE INDEX IF NOT EXISTS "idx_llm_audit_logs_request_id" ON "llm_audit_logs" ("request_id");
CREATE INDEX IF NOT EXISTS "idx_llm_audit_logs_demand_id" ON "llm_audit_logs" ("demand_id");
CREATE INDEX IF NOT EXISTS "idx_llm_audit_logs_user_id" ON "llm_audit_logs" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_llm_audit_logs_feedback" ON "llm_audit_logs" ("feedback");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pm_frameworks" (
  "id" text PRIMARY KEY,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "content" text NOT NULL,
  "version" text,
  "imported_at" timestamp NOT NULL
);
CREATE INDEX IF NOT EXISTS "pm_frameworks_slug_idx" ON "pm_frameworks" ("slug");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rag_feedback" (
  "id" uuid PRIMARY KEY,
  "query_id" text NOT NULL,
  "query_text" text NOT NULL,
  "chunk_id" text NOT NULL,
  "chunk_source" text NOT NULL DEFAULT 'comex_cambio',
  "was_helpful" boolean NOT NULL,
  "selected_by_user" boolean DEFAULT false,
  "feedback_type" text DEFAULT 'implicit',
  "session_id" text,
  "created_at" timestamp
);
CREATE INDEX IF NOT EXISTS "idx_rag_feedback_chunk" ON "rag_feedback" ("chunk_id");
CREATE INDEX IF NOT EXISTS "idx_rag_feedback_query" ON "rag_feedback" ("query_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "refinements" (
  "id" text PRIMARY KEY,
  "session_id" text NOT NULL,
  "input" text NOT NULL,
  "output" text NOT NULL,
  "metadata" jsonb NOT NULL,
  "created_at" timestamp NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_refinements_session_id" ON "refinements" ("session_id");
CREATE INDEX IF NOT EXISTS "idx_refinements_created_at" ON "refinements" ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retro_actions" (
  "id" text PRIMARY KEY,
  "retro_id" text NOT NULL,
  "description" text NOT NULL,
  "owner" text,
  "metric_key" text NOT NULL,
  "metric_before" double precision,
  "metric_after" double precision,
  "success_criteria" text,
  "created_at" timestamp NOT NULL
);
CREATE INDEX IF NOT EXISTS "retro_actions_retro_idx" ON "retro_actions" ("retro_id", "created_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retrospectives" (
  "id" text PRIMARY KEY,
  "period_start" text NOT NULL,
  "period_end" text NOT NULL,
  "snapshot" text NOT NULL,
  "created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "safety_logs" (
  "id" serial PRIMARY KEY,
  "timestamp" integer NOT NULL,
  "action" text NOT NULL,
  "confidence" text NOT NULL,
  "original_text_hash" text,
  "user_id" text,
  "demand_id" integer,
  "detections" jsonb NOT NULL,
  "latency_ms" integer NOT NULL DEFAULT 0,
  "guardrail_log_id" integer
);
CREATE INDEX IF NOT EXISTS "idx_safety_logs_timestamp" ON "safety_logs" ("timestamp");
CREATE INDEX IF NOT EXISTS "idx_safety_logs_action" ON "safety_logs" ("action");
CREATE INDEX IF NOT EXISTS "idx_safety_logs_confidence" ON "safety_logs" ("confidence");
