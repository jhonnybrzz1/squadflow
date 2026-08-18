-- Auditoria 2026-08-01 (A08 / demanda #10289): `backlog_activities.created_at`
-- é TEXT (migration 0044, default `datetime('now')`), mas a declaração Drizzle
-- dizia `integer timestamp`. Como a afinidade TEXT do SQLite converte números
-- em string ao gravar, a coluna acumulou DOIS formatos: 124 linhas em
-- `YYYY-MM-DD HH:MM:SS` e 5 em epoch-string (ex.: '1784896608').
--
-- `ORDER BY created_at DESC` compara lexicograficamente: '1784896608' < '2026-…'
-- para o SQLite, então as linhas em epoch afundavam para o fim da listagem do
-- backlog independentemente de quando foram criadas.
--
-- Normaliza tudo para o formato ISO da coluna. O WHERE só casa dígitos puros,
-- então rodar de novo é no-op e linhas já corretas não são tocadas.

UPDATE backlog_activities
SET created_at = datetime(CAST(created_at AS INTEGER), 'unixepoch')
WHERE created_at GLOB '[0-9]*' AND created_at NOT GLOB '*[^0-9]*';

UPDATE backlog_activities
SET updated_at = datetime(CAST(updated_at AS INTEGER), 'unixepoch')
WHERE updated_at GLOB '[0-9]*' AND updated_at NOT GLOB '*[^0-9]*';
