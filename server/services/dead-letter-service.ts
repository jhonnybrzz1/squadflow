import { desc, gte, sql } from 'drizzle-orm';
import { db } from '../db';
import { deadLetters } from '@shared/schema';
import { logger } from '../utils/logger';

export interface DeadLetterInput {
  eventId: string;
  eventType: string;
  payload: unknown;
  error: unknown;
}

export interface DeadLetterRecord {
  id: number;
  eventId: string;
  eventType: string;
  payload: string;
  truncated: boolean;
  errorMessage: string;
  errorStack: string | null;
  createdAt: Date;
}

const MAX_PAYLOAD_SIZE = 10 * 1024; // 10KB

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function serializePayload(
  payload: unknown,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const raw = JSON.stringify(payload);
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes <= maxBytes) return { text: raw, truncated: false };

  // Truncamento seguro respeitando UTF-8
  let slice = Math.floor((maxBytes * 0.95) / 4); // pior caso 4 bytes por char
  let candidate = raw.slice(0, slice);
  while (Buffer.byteLength(candidate, 'utf8') > maxBytes) {
    slice -= 1;
    candidate = raw.slice(0, slice);
  }
  return { text: candidate, truncated: true };
}

/**
 * M-2: DLQ persistente para eventos do SystemEventBus.
 */
export class DeadLetterService {
  async insert(input: DeadLetterInput): Promise<void> {
    const err = normalizeError(input.error);
    const { text, truncated } = serializePayload(input.payload, MAX_PAYLOAD_SIZE);

    const record = {
      eventId: input.eventId,
      eventType: input.eventType,
      payload: text,
      truncated,
      errorMessage: err.message,
      errorStack: err.stack ?? null,
    };

    try {
      await db.insert(deadLetters).values(record);
      logger.info('M-2: event stored in dead-letter queue', {
        context: {
          eventId: input.eventId,
          eventType: input.eventType,
          payloadSize: text.length,
          truncated,
          errorType: err.name,
          status: 'dlq',
        },
      });
    } catch (dbError) {
      logger.error('M-2: failed to persist dead letter', {
        error: dbError instanceof Error ? dbError : undefined,
        context: { eventId: input.eventId, eventType: input.eventType },
      });
      throw dbError;
    }
  }

  async list(since?: Date, limit = 50): Promise<DeadLetterRecord[]> {
    const safeLimit = Math.min(limit, 100);
    let query = db.select().from(deadLetters).orderBy(desc(deadLetters.createdAt)).limit(safeLimit);

    if (since) {
      query = query.where(gte(deadLetters.createdAt, since)) as typeof query;
    }

    return (await query) as DeadLetterRecord[];
  }

  async cleanupOlderThan(days = 30): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    try {
      const stmt = db.delete(deadLetters).where(sql`${deadLetters.createdAt} < ${cutoff}`);
      const result = await stmt;
      return result && typeof result === 'object' && 'rowsAffected' in result
        ? Number(result.rowsAffected ?? 0)
        : 0;
    } catch (error) {
      logger.warn('M-2: cleanup de dead letters falhou — tabela pode estar ausente', {
        error: error instanceof Error ? error : undefined,
        context: { days, cutoff: cutoff.toISOString() },
      });
      return 0;
    }
  }

  /**
   * M-2: métricas documentadas no código — contagem de falhas por eventType/dia.
   */
  async getMetrics(): Promise<{ eventType: string; date: string; count: number }[]> {
    const rows = await db
      .select({
        eventType: deadLetters.eventType,
        date: sql<string>`date(${deadLetters.createdAt})`.as('date'),
        count: sql<number>`count(*)`.as('count'),
      })
      .from(deadLetters)
      .groupBy(deadLetters.eventType, sql`date(${deadLetters.createdAt})`);

    return rows.map((r) => ({
      eventType: r.eventType,
      date: r.date,
      count: Number(r.count),
    }));
  }
}

export const deadLetterService = new DeadLetterService();
