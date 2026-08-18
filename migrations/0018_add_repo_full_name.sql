-- Departmentalização do RAG por repositório.
--
-- Contexto:
-- Antes desta migration a relação entre uma demanda e o repositório alvo era
-- inferida apenas por heurística sobre `demands.description` (regex
-- "Repositório: owner/name"). Como o RefinementRAGService consultava todos os
-- documentos de uma única tabela global, refinamentos de iniciativas distintas
-- vazavam contexto entre si — o agente recebia snippets de PRDs/Tasks de outro
-- repo só por similaridade textual.
--
-- A coluna `repo_full_name` torna a chave de departamento explícita e
-- pesquisável, e a coluna espelhada em `refinement_rag_documents` permite ao
-- RAG aplicar hard-filter por repositório no recall.

ALTER TABLE demands ADD COLUMN repo_full_name TEXT;

CREATE INDEX IF NOT EXISTS idx_demands_repo_full_name
  ON demands(repo_full_name);

-- A tabela `refinement_rag_documents` é criada em runtime por
-- RefinementRAGService.ensureSchema() — o serviço também aplica este ALTER
-- defensivamente para ambientes em que a tabela já existia. Repetimos aqui
-- para garantir o schema canônico em deploys que executam migrations.
ALTER TABLE refinement_rag_documents ADD COLUMN repo_full_name TEXT;

CREATE INDEX IF NOT EXISTS idx_refinement_rag_documents_repo_full_name
  ON refinement_rag_documents(repo_full_name);
