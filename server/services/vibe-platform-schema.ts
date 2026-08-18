/**
 * Demanda #10358 — Plataforma Online do Aichatflow para Vibe Coders (Fatia 1).
 * Demanda #10364 — Fatia 2A: tabela `subscriptions` + coluna `platform_user_id`
 * em `llm_audit_logs` para correlação de custo de IA por usuário.
 *
 * `ensureVibePlatformSchema()` idempotente para as tabelas novas da plataforma
 * pública, no mesmo padrão de `backlog-activity-service.ts`: SQL bruto via
 * `sql.raw` + guard `isPostgres` (Postgres recebe o schema via `migrations-pg/`,
 * não via runtime DDL). Compartilhado por todos os serviços da plataforma
 * pública para não duplicar cópias do mesmo DDL.
 */
import { sql } from 'drizzle-orm';
import { dbHelper, isPostgres } from '../db';

export const VIBE_PLATFORM_CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS platform_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    session_nonce TEXT,
    plan TEXT NOT NULL DEFAULT 'free',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    source TEXT DEFAULT 'landing'
  )`,
  `CREATE TABLE IF NOT EXISTS git_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'github',
    access_token_encrypted TEXT NOT NULL,
    github_username TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_git_connections_user_provider ON git_connections(user_id, provider)`,
  `CREATE TABLE IF NOT EXISTS usage_counters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    period TEXT NOT NULL,
    refinements_count INTEGER NOT NULL DEFAULT 0,
    connected_repos INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_counters_user_period ON usage_counters(user_id, period)`,
  `CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_analytics_events_user_event ON analytics_events(user_id, event_type)`,
  // Demanda #10364 (Fatia 2A) — subscriptions: estado canônico de assinatura Paddle.
  // `platform_users.plan` é cache derivado (atualizado pelo webhook); esta tabela
  // é a fonte de verdade. Grace period: status='canceled' + current_period_end > now = Pro.
  `CREATE TABLE IF NOT EXISTS subscriptions (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_paddle_id ON subscriptions(paddle_subscription_id)`,
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id)`,
  // Demanda #10365 (Fatia 2B) — db_connections: conexões de banco do usuário
  // para enriquecer refinamento com schema real. Credenciais cifradas (AES-256-GCM).
  `CREATE TABLE IF NOT EXISTS db_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    db_type TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER,
    database_name TEXT,
    username TEXT,
    encrypted_credentials TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_db_connections_user_name ON db_connections(user_id, name)`,
  `CREATE INDEX IF NOT EXISTS idx_db_connections_user_id ON db_connections(user_id)`,
  // Demanda #10366 (Fatia 2C) — preview_cache + preview_jobs
  `CREATE TABLE IF NOT EXISTS preview_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    result TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_preview_cache_user_repo ON preview_cache(user_id, owner, repo)`,
  `CREATE TABLE IF NOT EXISTS preview_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_preview_jobs_job_id ON preview_jobs(job_id)`,
];

let ensured = false;
let ensureInFlight: Promise<void> | null = null;

/** Permite reset em testes que trocam de instância de banco entre casos. */
export function __resetVibePlatformSchemaCacheForTests(): void {
  ensured = false;
  ensureInFlight = null;
}

async function ensureSqliteVibePlatformSchema(): Promise<void> {
  for (const statement of VIBE_PLATFORM_CREATE_STATEMENTS) {
    await dbHelper.run(sql.raw(statement));
  }
  // Demanda #10364 (Fatia 2A) — adicionar coluna platform_user_id em llm_audit_logs
  // para correlação de custo de IA por usuário da plataforma. Idempotente: SQLite
  // não suporta IF NOT EXISTS em ADD COLUMN, então verificamos via PRAGMA.
  const columns = await dbHelper.all<{ name: string }>(
    sql.raw(`PRAGMA table_info(llm_audit_logs)`),
  );
  const colNames = new Set(columns.map((r) => r.name));
  if (!colNames.has('platform_user_id')) {
    await dbHelper.run(
      sql.raw(
        `ALTER TABLE llm_audit_logs ADD COLUMN platform_user_id INTEGER REFERENCES platform_users(id) ON DELETE SET NULL`,
      ),
    );
  }
  // Demanda #10367 (Fatia 2D) — adicionar colunas is_active, deleted_at, admin
  // em platform_users para soft delete + middleware adminAuth. Idempotente via PRAGMA.
  const userCols = await dbHelper.all<{ name: string }>(
    sql.raw(`PRAGMA table_info(platform_users)`),
  );
  const userColNames = new Set(userCols.map((r) => r.name));
  if (!userColNames.has('is_active')) {
    await dbHelper.run(
      sql.raw(`ALTER TABLE platform_users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`),
    );
  }
  if (!userColNames.has('deleted_at')) {
    await dbHelper.run(sql.raw(`ALTER TABLE platform_users ADD COLUMN deleted_at INTEGER`));
  }
  if (!userColNames.has('admin')) {
    await dbHelper.run(
      sql.raw(`ALTER TABLE platform_users ADD COLUMN admin INTEGER NOT NULL DEFAULT 0`),
    );
  }
  ensured = true;
}

export async function ensureVibePlatformSchema(): Promise<void> {
  if (ensured || isPostgres) return;

  ensureInFlight ??= ensureSqliteVibePlatformSchema().finally(() => {
    ensureInFlight = null;
  });
  await ensureInFlight;
}
