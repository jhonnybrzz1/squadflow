-- DOC-001 fix: The original 0027 migration created a UNIQUE index on
-- (demand_id, doc_type, docu_mente_url). This was wrong for two reasons:
-- 1. Including docu_mente_url allows multiple logical documents for the
--    same (demand, docType) when the endpoint changes (e.g. port change).
-- 2. After a failed export, the row still exists with status='failed'.
--    A retry tries to INSERT a new row, but the unique index blocks it,
--    making the export unrecoverable.
--
-- This migration replaces the index with a UNIQUE on (demand_id, doc_type)
-- only. The service uses upsert (INSERT ... ON CONFLICT DO UPDATE) to
-- handle retries: a failed row is updated in place rather than rejected.

-- Drop the old 3-column unique index.
DROP INDEX IF EXISTS demand_external_docs_unic_idx;

-- Create the new 2-column unique index: one row per (demand, docType).
CREATE UNIQUE INDEX IF NOT EXISTS demand_external_docs_demand_doctype_idx
  ON demand_external_docs (demand_id, doc_type);
