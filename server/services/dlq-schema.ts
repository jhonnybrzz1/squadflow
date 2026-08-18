import { sql } from 'drizzle-orm';
import { dbHelper, isPostgres } from '../db';
import { logger } from '../utils/logger';

/**
 * Bug 10270: garantir que as tabelas de DLQ e agent_failures existam no SQLite
 * durante o boot. PostgreSQL continua migration-managed.
 *
 * DDL espelha migrations/0052_add_dlq_messages.sql,
 * migrations/0053_add_dead_letters.sql e migrations/0054_add_agent_failures.sql.
 */
export const dlqSqliteStatements = [
  // dlq_messages (Spec 10259 / 0052)
  `CREATE TABLE IF NOT EXISTS dlq_messages (
    id TEXT PRIMARY KEY NOT NULL,
    message_id TEXT NOT NULL,
    queue_name TEXT NOT NULL,
    payload TEXT NOT NULL,
    stack_trace TEXT NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    failed_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  'CREATE INDEX IF NOT EXISTS idx_dlq_messages_queue_name ON dlq_messages(queue_name)',
  'CREATE INDEX IF NOT EXISTS idx_dlq_messages_failed_at ON dlq_messages(failed_at)',
  'CREATE INDEX IF NOT EXISTS idx_dlq_messages_message_id ON dlq_messages(message_id)',

  // dead_letters (Spec 10240 M-2 / 0053)
  `CREATE TABLE IF NOT EXISTS dead_letters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0,
    error_message TEXT NOT NULL,
    error_stack TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  'CREATE INDEX IF NOT EXISTS idx_dead_letters_event_type ON dead_letters(event_type)',
  'CREATE INDEX IF NOT EXISTS idx_dead_letters_created_at ON dead_letters(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_dead_letters_event_id ON dead_letters(event_id)',

  // agent_failures (A-1 / 0054)
  `CREATE TABLE IF NOT EXISTS agent_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    error_category TEXT NOT NULL,
    error_message TEXT NOT NULL,
    stack_short TEXT,
    delay_applied INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  'CREATE INDEX IF NOT EXISTS idx_agent_failures_agent_created_at ON agent_failures(agent_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_agent_failures_execution_id ON agent_failures(execution_id)',
] as const;

export async function ensureDlqSchema(): Promise<void> {
  if (isPostgres) return;

  for (const statement of dlqSqliteStatements) {
    await dbHelper.run(sql.raw(statement));
  }

  logger.info('SQLite DLQ & agent failures schema ready', {
    context: {
      tables: ['dlq_messages', 'dead_letters', 'agent_failures'],
    },
  });
}
