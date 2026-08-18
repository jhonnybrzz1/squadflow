CREATE TABLE IF NOT EXISTS feedback_refinamento (
  id serial PRIMARY KEY,
  refinement_id text NOT NULL,
  agent_id text NOT NULL,
  nota integer,
  texto text,
  modelo text,
  qtd_iteracoes_ate_feedback integer,
  criado_em timestamp NOT NULL DEFAULT now()
);

ALTER TABLE feedback_refinamento
  ALTER COLUMN nota DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS item_index integer,
  ADD COLUMN IF NOT EXISTS item_key text,
  ADD COLUMN IF NOT EXISTS version_hash text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS atualizado_em timestamp NOT NULL DEFAULT now();

ALTER TABLE feedback_refinamento
  DROP CONSTRAINT IF EXISTS feedback_refinamento_nota_check,
  ADD CONSTRAINT feedback_refinamento_nota_check
    CHECK (nota IS NULL OR (nota >= 1 AND nota <= 5)),
  DROP CONSTRAINT IF EXISTS feedback_refinamento_status_check,
  ADD CONSTRAINT feedback_refinamento_status_check
    CHECK (status IS NULL OR status IN ('feito', 'não_feito', 'desatualizado'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_refinamento_item_version
  ON feedback_refinamento (refinement_id, version_hash, item_key);
