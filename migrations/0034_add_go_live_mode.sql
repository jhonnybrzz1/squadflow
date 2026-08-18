-- Spec 10015 — Modo Go-Live (fast-track) opt-in por demanda
--
-- Contexto:
-- Permite marcar uma demanda como "go-live" para que o pipeline pule etapas de
-- validação NÃO críticas (RAG quality, content guardrails), mantendo as críticas
-- (schema Zod, autenticação, erros de API). Acelera iterações de teste/exploração
-- sem comprometer a integridade. Nullable/default false para não afetar o histórico.

ALTER TABLE demands ADD COLUMN go_live_mode INTEGER DEFAULT false;
