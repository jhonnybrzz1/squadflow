-- Spec 10015 — Modo Go-Live (fast-track) opt-in por demanda (Postgres)
--
-- Ver migrations/0034_add_go_live_mode.sql (SQLite) para o contexto completo.

ALTER TABLE demands ADD COLUMN go_live_mode BOOLEAN DEFAULT false;
