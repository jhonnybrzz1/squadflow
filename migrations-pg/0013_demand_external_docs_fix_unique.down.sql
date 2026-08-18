-- Reverse: restore the old 3-column unique index.
BEGIN;
DROP INDEX IF EXISTS demand_external_docs_demand_doctype_idx;
CREATE UNIQUE INDEX IF NOT EXISTS demand_external_docs_unic_idx
  ON demand_external_docs (demand_id, doc_type, docu_mente_url);
COMMIT;
