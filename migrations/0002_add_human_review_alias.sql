-- Align governance fields with the human-review PRD while preserving
-- backwards compatibility with requires_approval.
ALTER TABLE demands ADD COLUMN requires_human_review INTEGER DEFAULT 0;
ALTER TABLE demands ADD COLUMN revision_number INTEGER NOT NULL DEFAULT 0;
ALTER TABLE demands ADD COLUMN review_requested_at INTEGER;
ALTER TABLE demands ADD COLUMN approved_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_demands_requires_human_review ON demands(requires_human_review);
CREATE INDEX IF NOT EXISTS idx_demands_revision_number ON demands(revision_number);
