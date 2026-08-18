/**
 * Contratos do agent-orchestrator.
 *
 * Extraídos de cognitive-core/agent-orchestrator.ts para que ai-squad possa
 * consumir o plano sem depender do cognitive-core.
 */

import type { EvidenceBlock } from '@shared/schema';
import type { DemandClassification } from './classification';
import type { SquadGraph } from './squad';

export interface AgentExecutionResult {
  agentName: string;
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
  evidence?: EvidenceBlock;
  timestamp: string;
}

export interface CrossValidationResult {
  validationPassed: boolean;
  validationNotes: string[];
  confidenceScore: number;
}

export interface OrchestrationPlan {
  demandId: number;
  classification: DemandClassification;
  agentExecutionOrder: string[];
  crossValidationRequired: boolean;
  validationAgents: string[];
  estimatedCompletionTime: number;
  notes: string;
  graph?: SquadGraph;
}
