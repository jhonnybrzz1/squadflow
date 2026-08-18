-- Lossless successor to 0013_demand_external_docs_fix_unique.sql.
BEGIN;

ALTER TABLE demand_external_docs
  ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS operation_token TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMP;

WITH ranked_documents AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY demand_id, doc_type
      ORDER BY
        CASE WHEN status = 'success' THEN 0 ELSE 1 END,
        completed_at DESC NULLS LAST,
        id DESC
    ) AS current_rank
  FROM demand_external_docs
)
UPDATE demand_external_docs AS document
SET is_current = (ranked.current_rank = 1)
FROM ranked_documents AS ranked
WHERE document.id = ranked.id;

DROP INDEX IF EXISTS demand_external_docs_unic_idx;
DROP INDEX IF EXISTS demand_external_docs_demand_doctype_idx;

CREATE UNIQUE INDEX IF NOT EXISTS demand_external_docs_current_idx
  ON demand_external_docs(demand_id, doc_type)
  WHERE is_current = TRUE;

COMMIT;
