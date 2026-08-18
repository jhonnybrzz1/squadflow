-- Remoção do domínio comex/câmbio — dropar tabelas RAG órfãs (Postgres)
--
-- Ver migrations/0035_drop_comex_cambio_rag.sql (SQLite) para o contexto completo.
-- As tabelas não existem mais no schema; o RAG de domínio lê do filesystem.
-- Idempotente: IF EXISTS. CASCADE remove índices/constraints dependentes.

DROP TABLE IF EXISTS comex_cambio_rag_chunks CASCADE;
DROP TABLE IF EXISTS comex_cambio_rag_documents CASCADE;
