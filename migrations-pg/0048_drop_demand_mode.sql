-- Spec 10146: remove o campo mode da tabela demands (idempotente).
-- O modo sequential é feature morta; o worker sempre executa roundtable.

ALTER TABLE demands DROP COLUMN IF EXISTS mode;
DROP INDEX IF EXISTS idx_demands_mode;
