-- Add per-demand AI usage/cost telemetry for builder dashboard
ALTER TABLE demands ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE demands ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE demands ADD COLUMN custo_estimado REAL NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_demands_custo_estimado ON demands(custo_estimado);
