import type { Demand } from './schema';

/**
 * Projeção curada e user-facing dos metadados de uma demanda (spec 10064).
 * Contrato REAL de `GET /api/demands/:id/metadata`. Fonte única backend↔front,
 * no mesmo padrão de `demand-list.ts`. NÃO devolve blobs pesados
 * (`chatMessages`, `documentVersions`, `classification`, ...).
 */
export interface DemandMetadata {
  id: number;
  title: string;
  // Identidade
  type: string;
  priority: string;
  refinementType: string | null;
  domain: string | null;
  // Execução
  status: string;
  /** Nº de agentes distintos que produziram mensagem `completed`. */
  agentCount: number;
  qualityGateStatus: string | null;
  // Custo
  promptTokens: number;
  completionTokens: number;
  custoEstimado: number;
  // Origem
  repoFullName: string | null;
  // Datas (ISO 8601 ou null)
  createdAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  // timestamps podem chegar como number (epoch) ou string ISO já hidratada.
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/**
 * Deriva o nº de agentes distintos a partir das mensagens `completed`.
 * Fonte honesta — `roundtable_config.agentIds` vem `[]` por efeito do 10058.
 */
function countDistinctAgents(demand: Demand): number {
  const messages = demand.chatMessages || [];
  const agents = new Set<string>();
  for (const message of messages) {
    if (message.type === 'completed' && message.agent) {
      agents.add(message.agent);
    }
  }
  return agents.size;
}

export function toDemandMetadata(demand: Demand): DemandMetadata {
  return {
    id: demand.id,
    title: demand.title,
    type: demand.type,
    priority: demand.priority,
    refinementType: demand.refinementType ?? null,
    domain: demand.domain ?? null,
    status: demand.status,
    agentCount: countDistinctAgents(demand),
    qualityGateStatus: demand.qualityGateStatus ?? null,
    promptTokens: demand.promptTokens ?? 0,
    completionTokens: demand.completionTokens ?? 0,
    custoEstimado: demand.custoEstimado ?? 0,
    repoFullName: demand.repoFullName ?? null,
    createdAt: toIso(demand.createdAt),
    completedAt: toIso(demand.completedAt),
    updatedAt: toIso(demand.updatedAt),
  };
}
