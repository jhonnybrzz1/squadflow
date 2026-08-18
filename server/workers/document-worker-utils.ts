import { logger } from '../utils/logger';
import { db, dbHelper } from '../db';
import { idempotencyRecords } from '@shared/schema-unified';
import { eq, sql } from 'drizzle-orm';

/**
 * Valida se a coluna 'last_succeeded_dialect' existe na tabela idempotency_records
 */
export async function validateIdempotencySchema(): Promise<void> {
  try {
    if (dbHelper.isPostgres) {
      const cols = await dbHelper.all<{ column_name: string }>(
        sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'idempotency_records' AND column_name = 'last_succeeded_dialect'`,
      );
      if (!cols || cols.length === 0) throw new Error('no column');
    } else {
      const cols = await dbHelper.all<{ name: string }>(
        sql`PRAGMA table_info('idempotency_records')`,
      );
      if (!cols.some((c) => c.name === 'last_succeeded_dialect')) throw new Error('no column');
    }
  } catch (err) {
    logger.error(
      `[DocumentWorker] SchemaIntegrityError: Coluna 'last_succeeded_dialect' não encontrada na tabela 'idempotency_records'. Execute a migration 0020_fix_idempotency_schema.sql.`,
      {
        error: err instanceof Error ? err : undefined,
        context: { event: 'DOCUMENT_GENERATION_FAILED' },
      },
    );
    throw new Error(
      "SchemaIntegrityError: Coluna 'last_succeeded_dialect' não encontrada na tabela 'idempotency_records'. Execute a migration 0020_fix_idempotency_schema.sql.",
    );
  }
}

/**
 * Registra uma chave de idempotência no banco de dados
 */
export async function registerIdempotencyKey(idempotencyKey: string): Promise<void> {
  try {
    await db.insert(idempotencyRecords).values({
      key: idempotencyKey,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h TTL
    });
    logger.info(`[DocumentWorker] Idempotency key ${idempotencyKey} registered.`);
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error.message.includes('no column named') ||
        error.message.includes('last_succeeded_dialect'))
    ) {
      const errMsg = 'Schema desatualizado: Execute migration 0020_fix_idempotency_schema.sql';
      logger.error(`[DocumentWorker] Schema drift detected. ${errMsg}`, { error });
      throw new Error(errMsg);
    }
    const errorCode = (error as { code?: string })?.code;
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      errorCode === 'SQLITE_CONSTRAINT_UNIQUE' ||
      errorCode === '23505' ||
      errorMessage.includes('UNIQUE constraint failed')
    ) {
      logger.info(`[DocumentWorker] Duplicate PDF generation skipped for key ${idempotencyKey}`);
      throw new Error('DUPLICATE_KEY');
    }
    throw error;
  }
}

/**
 * Registra o dialeto bem-sucedido para reconciliação futura
 */
export async function recordSuccessfulDialect(idempotencyKey: string): Promise<void> {
  try {
    await db
      .update(idempotencyRecords)
      .set({ lastSucceededDialect: dbHelper.isPostgres ? 'postgres' : 'sqlite' })
      .where(eq(idempotencyRecords.key, idempotencyKey));
  } catch (dialectErr: unknown) {
    if (
      dialectErr instanceof Error &&
      (dialectErr.message.includes('no column named') ||
        dialectErr.message.includes('last_succeeded_dialect'))
    ) {
      logger.error(
        '[DocumentWorker] Schema drift detected on update. Execute migration 0020_fix_idempotency_schema.sql',
        { error: dialectErr },
      );
      throw new Error('Schema desatualizado: Execute migration 0020_fix_idempotency_schema.sql');
    }
    logger.warn('[DocumentWorker] Could not record lastSucceededDialect', {
      error: dialectErr instanceof Error ? dialectErr : undefined,
    });
  }
}

/**
 * Remove a chave de idempotência para permitir retry manual
 */
export async function removeIdempotencyKey(idempotencyKey: string): Promise<void> {
  try {
    await db.delete(idempotencyRecords).where(eq(idempotencyRecords.key, idempotencyKey));
    logger.info(
      `[DocumentWorker] Idempotency key ${idempotencyKey} removed to allow manual retry.`,
    );
  } catch (_) {
    // Ignora erro de deleção silenciosamente
  }
}
