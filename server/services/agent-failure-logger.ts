import { db } from '../db';
import { agentFailures } from '@shared/schema';
import { logger } from '../utils/logger';

export interface AgentFailureInput {
  agentId: string;
  taskId: string;
  executionId: string;
  errorCategory: string;
  errorMessage: string;
  stackShort?: string | null;
  delayApplied?: number;
  attempt?: number;
}

/**
 * A-1: log estruturado de falhas de agente no AgentOrchestrator.
 * Persiste na tabela `agent_failures` com índice por agent_id + created_at.
 */
export class AgentFailureLogger {
  async log(input: AgentFailureInput): Promise<void> {
    try {
      await db.insert(agentFailures).values({
        agentId: input.agentId,
        taskId: input.taskId,
        executionId: input.executionId,
        errorCategory: input.errorCategory,
        errorMessage: input.errorMessage,
        stackShort: input.stackShort ?? null,
        delayApplied: input.delayApplied ?? 0,
        attempt: input.attempt ?? 0,
        createdAt: new Date(),
      });
      logger.info('A-1: agent failure logged', {
        context: {
          agent_id: input.agentId,
          task_id: input.taskId,
          execution_id: input.executionId,
          error_category: input.errorCategory,
          attempt: input.attempt,
        },
      });
    } catch (error) {
      logger.error('A-1: falha ao registrar agent failure', {
        error: error instanceof Error ? error : undefined,
        context: { agentId: input.agentId, taskId: input.taskId },
      });
    }
  }
}

export const agentFailureLogger = new AgentFailureLogger();
