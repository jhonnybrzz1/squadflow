-- Migration: Fix INTEGER columns to BIGINT for timestamps
-- Reason: Date.now() returns milliseconds since epoch which can exceed INTEGER max (2147483647)
-- Value 1778845253074 (May 2026 in ms) is too large for PostgreSQL INTEGER

-- comex_cambio_rag_documents
ALTER TABLE comex_cambio_rag_documents
  ALTER COLUMN updated_at TYPE BIGINT USING updated_at::BIGINT;

-- chunk_relevance_scores
ALTER TABLE chunk_relevance_scores
  ALTER COLUMN updated_at TYPE BIGINT USING updated_at::BIGINT;

-- refinement_rag_documents
ALTER TABLE refinement_rag_documents
  ALTER COLUMN updated_at TYPE BIGINT USING updated_at::BIGINT;

-- operation_attempts (from migration 0003)
ALTER TABLE operation_attempts
  ALTER COLUMN created_at TYPE BIGINT USING created_at::BIGINT;
ALTER TABLE operation_attempts
  ALTER COLUMN updated_at TYPE BIGINT USING updated_at::BIGINT;
ALTER TABLE operation_attempts
  ALTER COLUMN completed_at TYPE BIGINT USING completed_at::BIGINT;
