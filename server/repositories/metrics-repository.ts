import { db } from '../db';
import { progressiveRefinementRecords } from '@shared/schema-unified';

export interface ProgressiveRefinementMetricInput {
  executionId: string;
  demandId: number;
  complexity: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  risk: 'low' | 'medium' | 'high';
  levelTriaged: number;
  triageConfidence: number;
  triageReasonCodes: string[];
  levelExecuted: number;
  wasDowngraded: boolean;
  agentsUsed: string[];
  modelUsed: string;
  callsCountByStage: Record<string, number>;
  contextBudgetProxyByStage: Record<string, number>;
  tokensIn: number;
  tokensOut: number;
  costEstimated: number;
  costReal: number;
  reworkFlag: boolean;
  truncated: boolean;
  incomplete: boolean;
  artifactValidation: boolean;
  gateStatus: string;
  endedReason: string;
  experimentBucket: string;
  triagePolicyVersion: string;
  executionPolicyVersion: string;
}

/**
 * MetricsRepository — Fase 2 (Repository Pattern)
 *
 * Abstração sobre a persistência de métricas de execução e refinamento progressivo,
 * centralizando o acesso a dados de telemetria e custo.
 */
export class MetricsRepository {
  /**
   * Persiste um registro de refinamento progressivo com telemetria de execução.
   */
  async persistProgressiveRefinementRecord(input: ProgressiveRefinementMetricInput): Promise<void> {
    await db.insert(progressiveRefinementRecords).values({
      executionId: input.executionId,
      demandId: input.demandId,
      complexity: input.complexity,
      impact: input.impact,
      risk: input.risk,
      levelTriaged: input.levelTriaged,
      triageConfidence: input.triageConfidence,
      triageReasonCodes: input.triageReasonCodes,
      levelExecuted: input.levelExecuted,
      wasDowngraded: input.wasDowngraded ? true : false,
      agentsUsed: input.agentsUsed,
      modelUsed: input.modelUsed,
      callsCountByStage: input.callsCountByStage,
      contextBudgetProxyByStage: input.contextBudgetProxyByStage,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      costEstimated: input.costEstimated,
      costReal: input.costReal,
      reworkFlag: input.reworkFlag ? true : false,
      truncated: input.truncated ? true : false,
      incomplete: input.incomplete ? true : false,
      artifactValidation: input.artifactValidation ? true : false,
      gateStatus: input.gateStatus,
      endedReason: input.endedReason,
      experimentBucket: input.experimentBucket,
      triagePolicyVersion: input.triagePolicyVersion,
      executionPolicyVersion: input.executionPolicyVersion,
    });
  }
}

export const metricsRepository = new MetricsRepository();
