-- DOC-001: External document export tracking (DocuMente integration).
-- Makes the fire-and-forget DocuMente export traceable and idempotent.
CREATE TABLE IF NOT EXISTS demand_external_docs (
  id SERIAL PRIMARY KEY,
  demand_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('epic', 'userstories')),
  external_id TEXT,
  external_url TEXT,
  docu_mente_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS demand_external_docs_unic_idx
  ON demand_external_docs (demand_id, doc_type, docu_mente_url);
