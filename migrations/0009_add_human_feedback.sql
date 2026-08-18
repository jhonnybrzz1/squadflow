-- Human feedback on agent messages
CREATE TABLE IF NOT EXISTS human_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  demand_id INTEGER NOT NULL,
  agent_message_id TEXT NOT NULL,
  feedback_text TEXT NOT NULL DEFAULT '',
  feedback_type TEXT NOT NULL CHECK (feedback_type IN ('like', 'dislike')),
  agent TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_human_feedback_demand_id ON human_feedback(demand_id);
CREATE INDEX IF NOT EXISTS idx_human_feedback_agent_message_id ON human_feedback(agent_message_id);
