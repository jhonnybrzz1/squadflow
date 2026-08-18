-- Demanda 10088 (item 4): tabela agent_memory insert-only.
-- A criação real também ocorre em runtime via agentMemoryService.ensureSchema();
-- este arquivo mantém paridade com o tooling de migrations.
CREATE TABLE IF NOT EXISTS agent_memory (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  content TEXT NOT NULL,
  source_demand_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS agent_memory_lookup_idx
  ON agent_memory(agent_id, memory_type, created_at DESC);
