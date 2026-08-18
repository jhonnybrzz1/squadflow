-- Demanda 10094: memória episódica para self-improvement (skill de debugging).
-- Criação também em runtime via episodicMemoryStore.ensureSchema().
CREATE TABLE IF NOT EXISTS episodic_memory (
  id TEXT PRIMARY KEY NOT NULL,
  skill TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  sanitized INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL DEFAULT 'episodic',
  retry_count INTEGER,
  duration_ms INTEGER,
  memory_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS episodic_memory_skill_idx
  ON episodic_memory(skill, confidence DESC, created_at DESC);
