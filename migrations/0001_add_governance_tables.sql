-- Add governance fields to demands table
ALTER TABLE demands ADD COLUMN requires_approval INTEGER DEFAULT 0;
ALTER TABLE demands ADD COLUMN document_state TEXT DEFAULT 'DRAFT';
ALTER TABLE demands ADD COLUMN review_snapshot_id TEXT;
ALTER TABLE demands ADD COLUMN approved_snapshot_id TEXT;
ALTER TABLE demands ADD COLUMN approved_snapshot_hash TEXT;
ALTER TABLE demands ADD COLUMN final_snapshot_id TEXT;
ALTER TABLE demands ADD COLUMN finalized_from_hash TEXT;
ALTER TABLE demands ADD COLUMN approval_session_id TEXT;

-- Create document_snapshots table
CREATE TABLE IF NOT EXISTS document_snapshots (
  snapshot_id TEXT PRIMARY KEY NOT NULL,
  demand_id INTEGER NOT NULL,
  snapshot_type TEXT NOT NULL CHECK(snapshot_type IN ('REVIEW', 'APPROVED')),
  payload_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (demand_id) REFERENCES demands(id) ON DELETE CASCADE
);

-- Create approval_comments table
CREATE TABLE IF NOT EXISTS approval_comments (
  comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  demand_id INTEGER NOT NULL,
  review_snapshot_id TEXT,
  approved_snapshot_id TEXT,
  author TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (demand_id) REFERENCES demands(id) ON DELETE CASCADE
);

-- Create document_lifecycle_events table
CREATE TABLE IF NOT EXISTS document_lifecycle_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  demand_id INTEGER NOT NULL,
  requires_approval INTEGER NOT NULL,
  approval_session_id TEXT,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'DRAFT_TO_APPROVAL_REQUIRED',
    'APPROVAL_REQUIRED_TO_APPROVED',
    'APPROVED_TO_FINAL',
    'APPROVE_ATTEMPT',
    'FINALIZE_ATTEMPT',
    'SNAPSHOT_OUTDATED',
    'FINALIZE_PAYLOAD_REJECTED'
  )),
  review_snapshot_id TEXT,
  approved_snapshot_id TEXT,
  final_snapshot_id TEXT,
  finalized_from_hash TEXT,
  result_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (demand_id) REFERENCES demands(id) ON DELETE CASCADE
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_demands_document_state ON demands(document_state);
CREATE INDEX IF NOT EXISTS idx_demands_requires_approval ON demands(requires_approval);
CREATE INDEX IF NOT EXISTS idx_document_snapshots_demand_id ON document_snapshots(demand_id);
CREATE INDEX IF NOT EXISTS idx_document_snapshots_snapshot_type ON document_snapshots(snapshot_type);
CREATE INDEX IF NOT EXISTS idx_approval_comments_demand_id ON approval_comments(demand_id);
CREATE INDEX IF NOT EXISTS idx_document_lifecycle_events_demand_id ON document_lifecycle_events(demand_id);
CREATE INDEX IF NOT EXISTS idx_document_lifecycle_events_event_type ON document_lifecycle_events(event_type);
CREATE INDEX IF NOT EXISTS idx_document_lifecycle_events_created_at ON document_lifecycle_events(created_at);
