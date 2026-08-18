-- Expand guardrails: add confidence column + safety_logs view table

-- Add confidence column to existing guardrail_logs table
ALTER TABLE guardrail_logs ADD COLUMN confidence TEXT;

-- Safety logs: separate audit table for safety events
-- (provides the /api/safety/logs endpoint data with action semantics from PRD)
CREATE TABLE IF NOT EXISTS safety_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
  action TEXT NOT NULL,              -- PII_REDACTED | PROMPT_INJECTION_DETECTED
  confidence TEXT NOT NULL,          -- low | medium | high
  original_text_hash TEXT,           -- SHA256 prefix of original input
  user_id TEXT,
  demand_id INTEGER,
  detections TEXT NOT NULL DEFAULT '[]',  -- JSON array of detection types
  latency_ms INTEGER NOT NULL DEFAULT 0,
  guardrail_log_id INTEGER           -- FK to guardrail_logs for traceability
);

CREATE INDEX IF NOT EXISTS idx_safety_logs_timestamp ON safety_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_safety_logs_action ON safety_logs(action);
CREATE INDEX IF NOT EXISTS idx_safety_logs_confidence ON safety_logs(confidence);
