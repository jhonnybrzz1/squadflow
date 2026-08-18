-- A-1: tabela de falhas estruturadas do AgentOrchestrator.

CREATE TABLE IF NOT EXISTS agent_failures (
  id SERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  error_category TEXT NOT NULL,
  error_message TEXT NOT NULL,
  stack_short TEXT,
  delay_applied INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_failures_agent_created_at ON agent_failures(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_failures_execution_id ON agent_failures(execution_id);
