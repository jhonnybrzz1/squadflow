import { metricsRepository } from '../repositories/metrics-repository';
import { aiUsageTracker } from './ai-usage-tracker';
import { logger } from '../utils/logger';

export interface ProgressiveRefinementData {
  demandId: number;
  executionId: string;
  complexity: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  risk: 'low' | 'medium' | 'high';
  levelTriaged: number;
  triageConfidence?: number;
  triageReasonCodes?: string[];
  levelExecuted: number;
  wasDowngraded?: boolean;
  reworkFlag?: boolean;
  truncated?: boolean;
  incomplete?: boolean;
  artifactValidation?: boolean;
  gateStatus?: string;
  endedReason?: string;
  experimentBucket?: string;
  triagePolicyVersion?: string;
  executionPolicyVersion?: string;
}

export class ProgressiveRefinementService {
  /**
   * Persists the progressive refinement record at the end of the execution
   */
  async persistExecutionRecord(data: ProgressiveRefinementData): Promise<void> {
    try {
      // Get usage from AI usage tracker for this demand
      const usage = aiUsageTracker.getUsageForDemand(data.demandId);

      // Calcula callsCountByStage: contagem de chamadas por modelo usado
      const allRecords = aiUsageTracker.getAllRecords() || [];
      const demandRecords = allRecords.filter((r) => r.demandId === data.demandId);

      // Agrupa chamadas por modelo (proxy para stage)
      const callsCountByStage: Record<string, number> = {};
      const contextBudgetProxyByStage: Record<string, number> = {};

      for (const record of demandRecords) {
        const stage = record.model || 'unknown';
        callsCountByStage[stage] = (callsCountByStage[stage] || 0) + 1;
        contextBudgetProxyByStage[stage] =
          (contextBudgetProxyByStage[stage] || 0) + record.totalTokens;
      }

      await metricsRepository.persistProgressiveRefinementRecord({
        executionId: data.executionId,
        demandId: data.demandId,
        complexity: data.complexity,
        impact: data.impact,
        risk: data.risk,
        levelTriaged: data.levelTriaged,
        triageConfidence: data.triageConfidence ?? 100,
        triageReasonCodes: data.triageReasonCodes || [],
        levelExecuted: data.levelExecuted,
        wasDowngraded: data.wasDowngraded || false ? true : false,
        agentsUsed: usage.agentsUsed,
        modelUsed: Array.from(usage.modelsUsed).join(', ') || 'unknown',
        callsCountByStage,
        contextBudgetProxyByStage,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        costEstimated: usage.costEstimated,
        costReal: usage.costEstimated,
        reworkFlag: data.reworkFlag || false ? true : false,
        truncated: data.truncated || false ? true : false,
        incomplete: data.incomplete || false ? true : false,
        artifactValidation: (data.artifactValidation ?? true) ? true : false,
        gateStatus: data.gateStatus || 'passed',
        endedReason: data.endedReason || 'completed_successfully',
        experimentBucket: data.experimentBucket || 'baseline',
        triagePolicyVersion: data.triagePolicyVersion || '1.0.0',
        executionPolicyVersion: data.executionPolicyVersion || '1.0.0',
      });

      logger.info(`[Progressive Refinement] Execução registrada`, {
        context: {
          executionId: data.executionId,
          demandId: data.demandId,
          costEstimated: `$${usage.costEstimated.toFixed(4)}`,
          levelTriaged: data.levelTriaged,
          levelExecuted: data.levelExecuted,
          stagesUsed: Object.keys(callsCountByStage),
        },
      });
    } catch (error) {
      logger.error(
        `[Progressive Refinement] Erro ao persistir registro para demanda ${data.demandId}`,
        {
          error: error instanceof Error ? error : new Error(String(error)),
          context: { demandId: data.demandId, executionId: data.executionId },
        },
      );
    }
  }
}

export const progressiveRefinementService = new ProgressiveRefinementService();
