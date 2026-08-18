-- Demanda #10367 — Fatia 2D: Settings Page + Admin Dashboard (PR1)
-- Adiciona colunas is_active, deleted_at, admin em platform_users
-- para soft delete de conta + middleware adminAuth.

ALTER TABLE platform_users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE platform_users ADD COLUMN deleted_at INTEGER;
ALTER TABLE platform_users ADD COLUMN admin INTEGER NOT NULL DEFAULT 0;
