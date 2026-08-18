-- Fix timestamp columns to use DEFAULT NOW() instead of requiring explicit values
-- This prevents "invalid input syntax for type integer" errors when inserting timestamp strings
--
-- Spec 016 (auditoria H-12/SC-005): tornada CONDICIONAL por tipo para que a
-- cadeia aplique do zero. No baseline 0000 estas colunas são INTEGER (epoch) —
-- `DEFAULT NOW()` só é válido quando a coluna é timestamp (caso do banco
-- legado onde esta migração rodou originalmente). Em colunas INTEGER o default
-- correto é definido pela 0003. Comportamento em bancos já migrados: idêntico.

DO $$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT table_name FROM (VALUES
      ('model_routing_stage_runs'),
      ('agent_decision_records'),
      ('domain_execution_records')
    ) AS t(table_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = target.table_name
        AND column_name = 'created_at'
        AND data_type LIKE 'timestamp%'
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN created_at SET DEFAULT NOW()', target.table_name);
    END IF;
  END LOOP;
END $$;
