-- LLM Audit Logs for Comex & Câmbio regulatory compliance
-- Stores structured logs of all LLM interactions with regulatory fields
-- PRD: Observabilidade e Auditoria de LLM para Comex e Câmbio

CREATE TABLE IF NOT EXISTS llm_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Request identification
  request_id TEXT NOT NULL,
  -- User context
  user_id TEXT,
  user_name TEXT,
  -- LLM interaction content
  prompt TEXT NOT NULL,
  response TEXT NOT NULL,
  -- Model metadata
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  operation TEXT,
  agent_name TEXT,
  -- Performance
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER NOT NULL DEFAULT 200,
  error_message TEXT,
  -- Token usage
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL,
  -- Regulatory fields (Comex & Câmbio)
  duimp_id TEXT,
  contract_id TEXT,
  ncm TEXT,
  iof_flag INTEGER DEFAULT 0,
  -- Domain context
  domain TEXT DEFAULT 'geral',
  demand_id INTEGER,
  -- User feedback (Sprint 2)
  feedback TEXT CHECK (feedback IN ('positive', 'negative', NULL)),
  feedback_comment TEXT,
  feedback_at INTEGER,
  -- Timestamps
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_llm_audit_logs_created_at ON llm_audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_audit_logs_duimp_id ON llm_audit_logs(duimp_id);
CREATE INDEX IF NOT EXISTS idx_llm_audit_logs_contract_id ON llm_audit_logs(contract_id);
CREATE INDEX IF NOT EXISTS idx_llm_audit_logs_ncm ON llm_audit_logs(ncm);
CREATE INDEX IF NOT EXISTS idx_llm_audit_logs_request_id ON llm_audit_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_llm_audit_logs_demand_id ON llm_audit_logs(demand_id);
CREATE INDEX IF NOT EXISTS idx_llm_audit_logs_user_id ON llm_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_llm_audit_logs_feedback ON llm_audit_logs(feedback);
