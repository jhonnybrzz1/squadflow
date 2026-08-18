-- Migration 0014: RAG Improvements (Sprints 1-3)
-- 1.1 pgvector: native vector search for chunk embeddings
-- 3.1 Hierarchical chunks: parent-child relationships
-- 3.2 Feedback loop: RAG feedback tracking

-- =============================================
-- Sprint 1.1: pgvector support
-- =============================================

-- Enable vector extension (PostgreSQL only; SQLite ignores this)
CREATE EXTENSION IF NOT EXISTS vector;

-- Dedicated table for native vector embeddings (pgvector)
-- Stores embeddings as vector(3072) for OpenAI text-embedding-3-large
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id TEXT NOT NULL,
  chunk_source TEXT NOT NULL DEFAULT 'comex_cambio',  -- 'comex_cambio' | 'product_roles' | 'refinement'
  embedding vector(3072) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(chunk_id, chunk_source)
);

-- HNSW index for fast approximate nearest neighbor search
-- m=16, ef_construction=64 balances build time vs recall
CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_hnsw
  ON chunk_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Index for chunk lookups
CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_source
  ON chunk_embeddings (chunk_source);

-- =============================================
-- Sprint 3.1: Hierarchical parent-child chunks
-- =============================================

-- Add hierarchy columns to existing chunks table
ALTER TABLE comex_cambio_rag_chunks
  ADD COLUMN IF NOT EXISTS parent_chunk_id TEXT,
  ADD COLUMN IF NOT EXISTS chunk_level TEXT DEFAULT 'paragraph',
  ADD COLUMN IF NOT EXISTS summary TEXT;

-- Index for parent lookups
CREATE INDEX IF NOT EXISTS idx_chunks_parent
  ON comex_cambio_rag_chunks (parent_chunk_id);

CREATE INDEX IF NOT EXISTS idx_chunks_level
  ON comex_cambio_rag_chunks (chunk_level);

-- =============================================
-- Sprint 3.2: RAG feedback loop
-- =============================================

CREATE TABLE IF NOT EXISTS rag_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id TEXT NOT NULL,
  query_text TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  chunk_source TEXT NOT NULL DEFAULT 'comex_cambio',
  was_helpful BOOLEAN NOT NULL,
  selected_by_user BOOLEAN DEFAULT FALSE,
  feedback_type TEXT DEFAULT 'implicit',  -- 'implicit' | 'explicit' | 'click'
  session_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_feedback_chunk
  ON rag_feedback (chunk_id);

CREATE INDEX IF NOT EXISTS idx_rag_feedback_query
  ON rag_feedback (query_id);

-- Aggregated chunk scores (materialized from feedback)
CREATE TABLE IF NOT EXISTS chunk_relevance_scores (
  chunk_id TEXT NOT NULL,
  chunk_source TEXT NOT NULL DEFAULT 'comex_cambio',
  total_shown INTEGER DEFAULT 0,
  total_helpful INTEGER DEFAULT 0,
  total_selected INTEGER DEFAULT 0,
  success_rate REAL DEFAULT 0.0,
  boost_factor REAL DEFAULT 1.0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (chunk_id, chunk_source)
);
