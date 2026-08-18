import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db as defaultDb, type DbClient } from '../db';
import { logger } from '../utils/logger';
import { operationAttempts } from '@shared/schema-unified';

export type OperationAttemptStatus = 'blocked' | 'processing' | 'completed' | 'error';
export type OperationGateStatus = 'ready' | 'blocked';

export interface MvpGateInput {
  title?: string | null;
  description?: string | null;
  flowContract?: string | null;
}

export interface CreateOperationAttemptInput extends MvpGateInput {
  operationType: string;
  operationId?: string;
  demandId?: number | null;
  metadata?: Record<string, unknown>;
}

export interface OperationAttemptResult {
  attemptId: string;
  operationId: string;
  operationType: string;
  status: OperationAttemptStatus;
  gateStatus: OperationGateStatus;
  missingFields: string[];
}

const REQUIRED_MVP_FIELDS: Array<keyof MvpGateInput> = ['title', 'description', 'flowContract'];

export function validateMvpGate(input: MvpGateInput): {
  gateStatus: OperationGateStatus;
  missingFields: string[];
} {
  const missingFields = REQUIRED_MVP_FIELDS.filter((field) => !input[field]?.trim());

  return {
    gateStatus: missingFields.length === 0 ? 'ready' : 'blocked',
    missingFields,
  };
}

export class OperationAttemptService {
  constructor(private readonly database: DbClient = defaultDb) {}

  async createAttempt(input: CreateOperationAttemptInput): Promise<OperationAttemptResult> {
    const attemptId = randomUUID();
    const operationId = input.operationId || randomUUID();
    const gate = validateMvpGate(input);
    const status: OperationAttemptStatus = gate.gateStatus === 'ready' ? 'processing' : 'blocked';
    const now = new Date();

    await (this.database as any).insert(operationAttempts).values({
      attemptId,
      operationId,
      operationType: input.operationType,
      demandId: input.demandId ?? null,
      status,
      gateStatus: gate.gateStatus,
      missingFields: gate.missingFields,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    });

    logger.logBusinessEvent('operation_attempt_created', input.operationType, attemptId, {
      attemptId,
      operationId,
      status,
      gateStatus: gate.gateStatus,
      missingFields: gate.missingFields,
    });

    return {
      attemptId,
      operationId,
      operationType: input.operationType,
      status,
      gateStatus: gate.gateStatus,
      missingFields: gate.missingFields,
    };
  }

  async completeAttempt(attemptId: string): Promise<void> {
    const now = new Date();

    await (this.database as any)
      .update(operationAttempts)
      .set({
        status: 'completed',
        updatedAt: now,
        completedAt: now,
      })
      .where(eq(operationAttempts.attemptId, attemptId));

    logger.logBusinessEvent('operation_attempt_completed', 'operation_attempt', attemptId, {
      attemptId,
    });
  }

  async failAttempt(attemptId: string, errorCode: string, errorMessage: string): Promise<void> {
    const now = new Date();

    await (this.database as any)
      .update(operationAttempts)
      .set({
        status: 'error',
        errorCode,
        errorMessage,
        updatedAt: now,
        completedAt: now,
      })
      .where(eq(operationAttempts.attemptId, attemptId));

    logger.logBusinessEvent('operation_attempt_failed', 'operation_attempt', attemptId, {
      attemptId,
      errorCode,
      errorMessage,
    });
  }
}

export const operationAttemptService = new OperationAttemptService();
