-- Spec 10240 M-2: dead-letter queue para event bus.

CREATE TABLE IF NOT EXISTS dead_letters (
  id SERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  truncated BOOLEAN NOT NULL DEFAULT FALSE,
  error_message TEXT NOT NULL,
  error_stack TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dead_letters_event_type ON dead_letters(event_type);
CREATE INDEX IF NOT EXISTS idx_dead_letters_created_at ON dead_letters(created_at);
CREATE INDEX IF NOT EXISTS idx_dead_letters_event_id ON dead_letters(event_id);
