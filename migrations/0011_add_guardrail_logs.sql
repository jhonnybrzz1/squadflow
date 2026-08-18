-- Guardrail event logs for security audit
-- Stores prompt injection blocks, PII masking events, and moderation actions

CREATE TABLE IF NOT EXISTS guardrail_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
  guardrail_type TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  input_hash TEXT NOT NULL,
  detections TEXT NOT NULL DEFAULT '[]',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  user_id TEXT,
  demand_id INTEGER,
  request_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_guardrail_logs_timestamp ON guardrail_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_guardrail_logs_type ON guardrail_logs(guardrail_type);
CREATE INDEX IF NOT EXISTS idx_guardrail_logs_action ON guardrail_logs(action);
