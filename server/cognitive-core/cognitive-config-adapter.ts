/**
 * Spec 10144 — Cognitive Config Adapter
 *
 * Interface única de conexão entre o pipeline 'declarado' (cognitive-core)
 * e o pipeline 'vivo' (ai-squad roundtable). Converte os outputs espalhados
 * do cognitive-core em um formato enriquecido e acionável para o ai-squad.
 */

import type { Demand } from '@shared/schema';
import { getDemandTypeConfig } from '@shared/demand-types';
import type { DemandClassification } from '../orchestration-contracts';
import type { FullConstraints } from './reality-constraints';
import type { ProjectReality } from './project-reality-reader';
import type {
  RoundtableConfig,
  CognitiveCoreOutput,
  CognitiveCoreConstraint,
  CognitiveCoreSpecialist,
} from '../orchestration-contracts';

export type {
  CognitiveCoreConstraint,
  CognitiveCoreSpecialist,
  CognitiveCoreOutput,
} from '../orchestration-contracts';

export interface CognitiveConfigAdapterInput {
  demand: Demand;
  classification: DemandClassification;
  constraints?: FullConstraints | null;
  projectReality?: ProjectReality | null;
}

const DEFAULT_FRAMEWORK = 'TypeScript/React/Node.js';

/**
 * Detecta o framework principal a partir do projeto (stack) ou do tipo de demanda.
 */
function detectFramework(
  demand: Demand,
  projectReality: ProjectReality | null | undefined,
): string {
  const stack = projectReality?.stack;
  const parts: string[] = [];

  if (stack?.frontend?.length) parts.push(stack.frontend[0]);
  if (stack?.backend?.length) parts.push(stack.backend[0]);
  if (stack?.database?.length) parts.push(stack.database[0]);

  if (parts.length > 0) return parts.join('/');
  return demand.type ?? DEFAULT_FRAMEWORK;
}

/**
 * Converte FullConstraints em CognitiveCoreConstraint[].
 */
function buildConstraints(constraints?: FullConstraints | null): CognitiveCoreConstraint[] {
  const result: CognitiveCoreConstraint[] = [];
  if (!constraints) return result;

  if (constraints.maxEffortDays != null && constraints.maxEffortDays > 0) {
    result.push({
      name: 'max_effort_days',
      severity: 'high',
      description: `Esforço máximo: ${constraints.maxEffortDays} dias`,
    });
  }

  if (constraints.allowedTechnologies && constraints.allowedTechnologies.length > 0) {
    result.push({
      name: 'allowed_technologies',
      severity: 'medium',
      description: `Tecnologias permitidas: ${constraints.allowedTechnologies.join(', ')}`,
    });
  }

  if (constraints.forbiddenTechnologies && constraints.forbiddenTechnologies.length > 0) {
    result.push({
      name: 'forbidden_technologies',
      severity: 'high',
      description: `Tecnologias proibidas: ${constraints.forbiddenTechnologies.join(', ')}`,
    });
  }

  if (constraints.typeRequirements && constraints.typeRequirements.length > 0) {
    result.push({
      name: 'type_requirements',
      severity: 'medium',
      description: `Requisitos: ${constraints.typeRequirements.join(', ')}`,
    });
  }

  return result;
}

/**
 * Converte recommendedAgents/agentExecutionOrder em specialists.
 */
function buildSpecialists(classification: DemandClassification): CognitiveCoreSpecialist[] {
  const agents = classification.recommendedAgents?.length ? classification.recommendedAgents : [];

  return agents.map((agentId, index) => ({
    agentId,
    role: agentId,
    priority: index + 1,
  }));
}

/**
 * Adaptador puro: cognitive-core output → CognitiveCoreOutput.
 */
export function adaptCognitiveCoreOutput(input: CognitiveConfigAdapterInput): CognitiveCoreOutput {
  const { demand, classification, constraints, projectReality } = input;

  return {
    demandId: demand.id,
    classification: {
      // Spec 10144: type deve ser o tipo canônico da demanda (ex: 'security'),
      // não a categoria grossa do classificador (ex: 'technical').
      type: constraints?.canonicalDemandType || demand.type || 'unknown',
      category: classification.category,
      confidence: classification.confidence ?? 0,
    },
    constraints: buildConstraints(constraints),
    specialists: buildSpecialists(classification),
    framework: detectFramework(demand, projectReality),
    numericFields: {
      maxEffortDays: constraints?.maxEffortDays ?? 0,
      // Spec 10144: maxRounds é independente de maxEffortDays.
      // Usa a configuração canônica do tipo de demanda, com teto de segurança.
      maxRounds: Math.min(getDemandTypeConfig(demand.type).constraints.maxRounds, 5),
      confidence: classification.confidence ?? 0,
    },
  };
}

/**
 * Converte CognitiveCoreOutput em RoundtableConfig usável pelo squad-coordinator.
 * Mapeia specialists → agentIds e framework/nível de maturidade → refinementLevel.
 */
export function toRoundtableConfig(output: CognitiveCoreOutput): RoundtableConfig {
  const agentIds = output.specialists.map((s) => s.agentId).filter(Boolean);
  const hasHighSeverityConstraint = output.constraints.some(
    (c) => c.severity === 'high' || c.severity === 'critical',
  );
  const refinementLevel = hasHighSeverityConstraint ? 3 : 2;

  return {
    agentIds,
    maxRounds: output.numericFields.maxRounds,
    refinementLevel,
  };
}

export { DEFAULT_FRAMEWORK };
