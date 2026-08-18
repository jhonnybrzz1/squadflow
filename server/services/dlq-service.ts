import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { dlqMessages } from '@shared/schema';
import { logger } from '../utils/logger';

export interface DlqMessageInput {
  messageId: string;
  queueName: string;
  payload: Record<string, unknown>;
  stackTrace: string;
  retryCount?: number;
}

export interface DlqMessage {
  id: string;
  messageId: string;
  queueName: string;
  payload: Record<string, unknown>;
  stackTrace: string;
  retryCount: number;
  failedAt: Date;
  createdAt: Date;
}

/**
 * Serviço de Dead-Letter Queue (DLQ) persistente.
 *
 * Após N falhas consecutivas, uma mensagem é movida para a tabela `dlq_messages`
 * com payload, stack trace e metadados para análise posterior.
 */
class DlqService {
  async sendToDlq(input: DlqMessageInput): Promise<void> {
    const id = uuidv4();
    const now = new Date();
    const record = {
      id,
      messageId: input.messageId,
      queueName: input.queueName,
      payload: input.payload,
      stackTrace: input.stackTrace,
      retryCount: input.retryCount ?? 0,
      failedAt: now,
      createdAt: now,
    };

    try {
      await db.insert(dlqMessages).values(record);
      logger.warn('Mensagem movida para DLQ', {
        context: {
          id,
          messageId: input.messageId,
          queueName: input.queueName,
          retryCount: input.retryCount,
        },
      });
    } catch (err) {
      logger.error('Falha ao persistir mensagem na DLQ', {
        error: err instanceof Error ? err : undefined,
        context: { messageId: input.messageId, queueName: input.queueName },
      });
      throw err;
    }
  }

  async listByQueue(queueName: string, limit = 100): Promise<DlqMessage[]> {
    const rows = (await db
      .select()
      .from(dlqMessages)
      .where(eq(dlqMessages.queueName, queueName))
      .orderBy(dlqMessages.failedAt)
      .limit(limit)) as DlqMessage[];
    return rows;
  }

  async getByMessageId(messageId: string): Promise<DlqMessage | undefined> {
    const rows = (await db
      .select()
      .from(dlqMessages)
      .where(eq(dlqMessages.messageId, messageId))
      .limit(1)) as DlqMessage[];
    return rows[0];
  }

  async delete(id: string): Promise<void> {
    await db.delete(dlqMessages).where(eq(dlqMessages.id, id));
  }

  async count(queueName?: string): Promise<number> {
    const query = db.select({ count: dlqMessages.id }).from(dlqMessages);
    if (queueName) {
      query.where(eq(dlqMessages.queueName, queueName));
    }
    const rows = (await query) as { count: string }[];
    return Number(rows[0]?.count ?? 0);
  }
}

export const dlqService = new DlqService();
