import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { refinements, type InsertRefinement } from '@shared/schema';
import { logger } from '../utils/logger';

export interface RefinementRecordInput {
  sessionId: string;
  input: string;
  output: string;
  metadata: Record<string, unknown>;
}

/**
 * Persiste dados brutos de uma execução de refinamento.
 * Fail-safe: erros são logados e não propagados.
 *
 * @deprecated Dead-code-report-AiChatFlow1-2026-07-28 (demanda #10269):
 * função sem caller confirmado; preservada para decisão futura. TODO: remover
 * ou reintegrar ao pipeline de refinamento.
 */
export async function saveRefinement(input: RefinementRecordInput): Promise<void> {
  const record: InsertRefinement = {
    id: randomUUID(),
    sessionId: input.sessionId,
    input: input.input,
    output: input.output,
    metadata: input.metadata,
    createdAt: new Date(),
  };

  try {
    await db.insert(refinements).values(record);
    logger.debug('refinements: registro persistido', {
      context: { id: record.id, sessionId: input.sessionId },
    });
  } catch (error) {
    logger.error('refinements: falha ao persistir registro', {
      error: error instanceof Error ? error : undefined,
      context: { sessionId: input.sessionId },
    });
  }
}
