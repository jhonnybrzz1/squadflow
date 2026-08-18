-- Migration #10147: embedding_cache com chave composta (text_hash, model_id, dimensions)
-- A tabela é de cache; dados antigos são descartáveis, portante recriamos para
-- garantir schema correto e idempotência.

DROP TABLE IF EXISTS embedding_cache;

CREATE TABLE embedding_cache (
  text_hash TEXT NOT NULL,
  embedding TEXT NOT NULL,
  model_id TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (text_hash, model_id, dimensions)
);
