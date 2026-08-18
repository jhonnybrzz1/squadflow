-- Spec 10259 T2: dead-letter queue persistente para mensagens com falhas consecutivas.

CREATE TABLE IF NOT EXISTS dlq_messages (
  id TEXT PRIMARY KEY NOT NULL,
  message_id TEXT NOT NULL,
  queue_name TEXT NOT NULL,
  payload TEXT NOT NULL,
  stack_trace TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  failed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_dlq_messages_queue_name ON dlq_messages(queue_name);
CREATE INDEX IF NOT EXISTS idx_dlq_messages_failed_at ON dlq_messages(failed_at);
CREATE INDEX IF NOT EXISTS idx_dlq_messages_message_id ON dlq_messages(message_id);
