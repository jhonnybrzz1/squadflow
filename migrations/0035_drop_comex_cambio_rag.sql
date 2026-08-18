-- Remoção do domínio comex/câmbio — dropar tabelas RAG órfãs (SQLite)
--
-- Contexto:
-- O AiChatFlow1 deixou de ser focado em Comércio Exterior/Câmbio. As tabelas
-- `comex_cambio_rag_documents` e `comex_cambio_rag_chunks` já NÃO existem no
-- schema (`shared/schema.ts`) — o RAG de domínio hoje lê corpus curado do
-- filesystem (`knowledge/domains/<dominio>/*.json`), não do banco. Elas
-- permanecem apenas em bancos legados criados por migrations antigas
-- (0010/0014/0015). Este forward-migration remove essas tabelas órfãs.
--
-- Idempotente e seguro: IF EXISTS não falha se as tabelas já não existirem.
-- Nada em produção lê essas tabelas, então não há perda de dado ativo.

DROP TABLE IF EXISTS comex_cambio_rag_chunks;
DROP TABLE IF EXISTS comex_cambio_rag_documents;
