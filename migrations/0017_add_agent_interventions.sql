-- Anti-Overengineering Agent: intervenções registradas por demanda
-- Armazena o parecer estruturado (3 campos) e o impacto de esforço antes/depois
CREATE TABLE IF NOT EXISTS agent_interventions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  demand_id INTEGER NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  pontos_overengineering TEXT NOT NULL,          -- JSON array de strings
  escopo_reduzido TEXT NOT NULL,                 -- texto livre: escopo sugerido pelo agente
  roi_estimado TEXT NOT NULL,                    -- formato "X:1"
  esforco_original_dias REAL,                    -- estimativa antes da intervenção (em dias)
  esforco_reduzido_dias REAL,                    -- estimativa após a intervenção (em dias)
  dias_economizados REAL                         -- calculado: esforco_original - esforco_reduzido
    GENERATED ALWAYS AS (
      CASE
        WHEN esforco_original_dias IS NOT NULL AND esforco_reduzido_dias IS NOT NULL
        THEN esforco_original_dias - esforco_reduzido_dias
        ELSE NULL
      END
    ) STORED,
  override_applied INTEGER NOT NULL DEFAULT 0,   -- boolean: 1 = PO/TL ignorou a intervenção
  override_by TEXT,                              -- userId que fez o override
  override_justification TEXT,
  modelo TEXT,                                   -- modelo LLM utilizado
  criado_em INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_agent_interventions_demand_id ON agent_interventions(demand_id);
CREATE INDEX IF NOT EXISTS idx_agent_interventions_criado_em ON agent_interventions(criado_em);

-- Campo max_effort_override na tabela demands (PO/TL pode aumentar teto de esforço)
ALTER TABLE demands ADD COLUMN max_effort_override_dias REAL;
ALTER TABLE demands ADD COLUMN max_effort_override_by TEXT;
ALTER TABLE demands ADD COLUMN max_effort_override_justification TEXT;
