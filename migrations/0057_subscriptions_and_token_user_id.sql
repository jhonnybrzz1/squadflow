-- Demanda #10364 — Fatia 2A: Sistema de Pagamento e Plano Pro (Paddle).
-- Tabela `subscriptions` (fonte canônica de assinatura) + coluna `platform_user_id`
-- em `llm_audit_logs` para correlação de custo de IA por usuário da plataforma.

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'pro',
  status TEXT NOT NULL DEFAULT 'active',
  paddle_subscription_id TEXT NOT NULL UNIQUE,
  paddle_customer_id TEXT,
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_paddle_id ON subscriptions(paddle_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);

-- platform_user_id em llm_audit_logs: nullable (logs legados e admin local não têm).
-- SQLite não suporta IF NOT EXISTS em ADD COLUMN — o ensureVibePlatformSchema()
-- verifica via PRAGMA antes de executar o ALTER.
