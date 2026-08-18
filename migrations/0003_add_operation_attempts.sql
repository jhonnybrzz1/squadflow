CREATE TABLE IF NOT EXISTS operation_attempts (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  demand_id INTEGER,
  status TEXT NOT NULL CHECK(status IN ('blocked', 'processing', 'completed', 'error')),
  gate_status TEXT NOT NULL CHECK(gate_status IN ('ready', 'blocked')),
  missing_fields TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (demand_id) REFERENCES demands(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_operation_attempts_operation_id ON operation_attempts(operation_id);
CREATE INDEX IF NOT EXISTS idx_operation_attempts_status ON operation_attempts(status);
CREATE INDEX IF NOT EXISTS idx_operation_attempts_created_at ON operation_attempts(created_at);
