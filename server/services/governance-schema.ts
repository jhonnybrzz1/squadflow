import { sql } from 'drizzle-orm';
import { dbHelper, isPostgres } from '../db';
import { logger } from '../utils/logger';

/**
 * Local SQLite runs demands in MemStorage by default, while governance audit
 * records live in SQLite. These idempotent tables therefore intentionally do
 * not declare a foreign key to `demands`, which may not exist in that mode.
 * Production Postgres remains migration-managed and is never changed here.
 */
export const governanceSqliteStatements = [
  `CREATE TABLE IF NOT EXISTS document_snapshots (
    snapshot_id TEXT PRIMARY KEY NOT NULL,
    demand_id INTEGER NOT NULL,
    snapshot_type TEXT NOT NULL CHECK(snapshot_type IN ('REVIEW', 'APPROVED')),
    payload_json TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS approval_comments (
    comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
    demand_id INTEGER NOT NULL,
    review_snapshot_id TEXT,
    approved_snapshot_id TEXT,
    author TEXT,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS document_lifecycle_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    demand_id INTEGER NOT NULL,
    requires_approval INTEGER NOT NULL,
    approval_session_id TEXT,
    event_type TEXT NOT NULL,
    review_snapshot_id TEXT,
    approved_snapshot_id TEXT,
    final_snapshot_id TEXT,
    finalized_from_hash TEXT,
    result_code TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_document_snapshots_demand_id ON document_snapshots(demand_id)',
  'CREATE INDEX IF NOT EXISTS idx_approval_comments_demand_id ON approval_comments(demand_id)',
  'CREATE INDEX IF NOT EXISTS idx_document_lifecycle_events_demand_id ON document_lifecycle_events(demand_id)',
] as const;

export async function ensureGovernanceSchema(): Promise<void> {
  if (isPostgres) return;

  for (const statement of governanceSqliteStatements) {
    await dbHelper.run(sql.raw(statement));
  }

  logger.info('SQLite governance schema ready', {
    context: { tables: ['document_snapshots', 'approval_comments', 'document_lifecycle_events'] },
  });
}
