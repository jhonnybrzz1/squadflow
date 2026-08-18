-- Migration: Add client_errors table for React error instrumentation
-- Purpose: Collect client-side errors for 48h to validate hypothesis about non-serializable objects (#419)

CREATE TABLE IF NOT EXISTS client_errors (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id TEXT NOT NULL,
  component TEXT NOT NULL,
  error_message TEXT NOT NULL,
  stack_trace TEXT DEFAULT '',
  payload JSONB DEFAULT '{}',
  data_source TEXT NOT NULL CHECK (data_source IN ('gov_api', 'internal', 'ai_model', 'unknown')),
  user_agent TEXT DEFAULT '',
  url TEXT DEFAULT ''
);

-- Index for time-based queries (48h analysis)
CREATE INDEX IF NOT EXISTS idx_client_errors_timestamp ON client_errors (timestamp DESC);

-- Index for data source analysis
CREATE INDEX IF NOT EXISTS idx_client_errors_data_source ON client_errors (data_source, timestamp DESC);

-- Index for component analysis
CREATE INDEX IF NOT EXISTS idx_client_errors_component ON client_errors (component, timestamp DESC);

-- Index for session deduplication
CREATE INDEX IF NOT EXISTS idx_client_errors_session ON client_errors (session_id, timestamp DESC);

-- Comment explaining the table purpose
COMMENT ON TABLE client_errors IS 'Client-side React errors collected for instrumentation. Used to validate hypothesis about non-serializable objects causing error #419.';
COMMENT ON COLUMN client_errors.data_source IS 'Categorization of error source: gov_api (government APIs), internal (React/app), ai_model (LLM responses), unknown';
COMMENT ON COLUMN client_errors.payload IS 'Serialized error context including componentStack and serialization error details';
