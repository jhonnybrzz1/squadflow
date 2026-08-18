-- Spec 10146: remove o campo mode da tabela demands.
-- O modo sequential é feature morta; o worker sempre executa roundtable.
--
-- A remoção física da coluna é feita de forma idempotente em runtime por
-- server/db/migrations.ts:dropDemandModeColumnIfExists, que recria a tabela
-- preservando o nome "demands" (as foreign keys filhas permanecem válidas).
-- Aqui removemos apenas o índice associado, se ainda existir.
DROP INDEX IF EXISTS idx_demands_mode;
