-- Lossless successor to 0029_demand_external_docs_fix_unique.sql.
-- Historical exports remain queryable while one deterministic current row is
-- selected for each logical document.
BEGIN IMMEDIATE;

-- @if-column-missing demand_external_docs.is_current
ALTER TABLE demand_external_docs ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1;
-- @if-column-missing demand_external_docs.operation_token
ALTER TABLE demand_external_docs ADD COLUMN operation_token TEXT;
-- @if-column-missing demand_external_docs.lease_expires_at
ALTER TABLE demand_external_docs ADD COLUMN lease_expires_at INTEGER;

WITH ranked_documents AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY demand_id, doc_type
      ORDER BY
        CASE WHEN status = 'success' THEN 0 ELSE 1 END,
        CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END,
        completed_at DESC,
        id DESC
    ) AS current_rank
  FROM demand_external_docs
)
UPDATE demand_external_docs
SET is_current = CASE
  WHEN id IN (SELECT id FROM ranked_documents WHERE current_rank = 1) THEN 1
  ELSE 0
END;

DROP INDEX IF EXISTS demand_external_docs_unic_idx;
DROP INDEX IF EXISTS demand_external_docs_demand_doctype_idx;

CREATE UNIQUE INDEX IF NOT EXISTS demand_external_docs_current_idx
  ON demand_external_docs(demand_id, doc_type)
  WHERE is_current = 1;

COMMIT;
