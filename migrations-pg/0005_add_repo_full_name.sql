-- Departmentalização do RAG por repositório (espelho Postgres).
-- Ver migrations/0018_add_repo_full_name.sql para contexto completo.

ALTER TABLE demands ADD COLUMN IF NOT EXISTS repo_full_name TEXT;

CREATE INDEX IF NOT EXISTS idx_demands_repo_full_name
  ON demands(repo_full_name);

-- Spec 016 (H-12/SC-005): esta tabela era criada apenas em runtime
-- (refinement-rag.ensureSchema). Criada aqui com a MESMA definição para que a
-- cadeia aplique do zero; idempotente em bancos onde já existe.
CREATE TABLE IF NOT EXISTS refinement_rag_documents (
  id TEXT PRIMARY KEY NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  demand_id INTEGER,
  doc_type TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding TEXT,
  repo_full_name TEXT,
  updated_at BIGINT NOT NULL
);

ALTER TABLE refinement_rag_documents
  ADD COLUMN IF NOT EXISTS repo_full_name TEXT;

CREATE INDEX IF NOT EXISTS idx_refinement_rag_documents_repo_full_name
  ON refinement_rag_documents(repo_full_name);
