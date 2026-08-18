-- DOC-001 fix: Replace the 3-column unique index with a 2-column one.
-- See migrations/0029 for the full rationale.
BEGIN;
DROP INDEX IF EXISTS demand_external_docs_unic_idx;
CREATE UNIQUE INDEX IF NOT EXISTS demand_external_docs_demand_doctype_idx
  ON demand_external_docs (demand_id, doc_type);
COMMIT;
