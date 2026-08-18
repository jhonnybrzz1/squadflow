-- Structured refinement feedback (nota 1-5 + texto opcional, por agente e refinamento)
CREATE TABLE IF NOT EXISTS feedback_refinamento (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  refinement_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  nota INTEGER NOT NULL CHECK (nota >= 1 AND nota <= 5),
  texto TEXT,
  modelo TEXT,
  qtd_iteracoes_ate_feedback INTEGER,
  criado_em INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_feedback_refinamento_agent_id ON feedback_refinamento(agent_id);
CREATE INDEX IF NOT EXISTS idx_feedback_refinamento_refinement_id ON feedback_refinamento(refinement_id);
