/**
 * Contratos do grafo explícito da squad (Fase 5 / slice 3).
 *
 * Extraídos de services/ai-squad/squad-graph.ts para que cognitive-core e
 * ai-squad possam depender deles sem formar ciclo.
 */

import type { DemandClassification } from './classification';

export type SquadNodeKind = 'agent' | 'deliberation';

/** Id canônico do nó de deliberação (roundtable) no grafo. */
export const DELIBERATION_NODE_ID = 'roundtable';

export type SquadInclusionReason = 'classifier_recommended' | 'orchestration_added';

export interface SquadNode {
  id: string;
  kind: SquadNodeKind;
  inclusion?: SquadInclusionReason;
}

export type SquadEdgeReason =
  | 'po_first'
  | 'tech_lead_before_qa'
  | 'pm_first_business'
  | 'scrum_master_last'
  | 'feeds_deliberation';

export interface SquadEdge {
  from: string;
  to: string;
  reason: SquadEdgeReason;
}

export interface SquadExcludedCandidate {
  id: string;
  reason: 'level_filtered';
}

export interface SquadComposition {
  level: 1 | 2 | 3;
  excluded: SquadExcludedCandidate[];
}

export interface SquadGraph {
  nodes: SquadNode[];
  edges: SquadEdge[];
  composition?: SquadComposition;
}

export function buildSquadGraph(classification: DemandClassification, order: string[]): SquadGraph {
  const recommended = new Set(classification.recommendedAgents);
  const nodes: SquadNode[] = order.map((id) => ({
    id,
    kind: 'agent',
    inclusion: recommended.has(id) ? 'classifier_recommended' : 'orchestration_added',
  }));

  const orderSet = new Set(order);
  const excluded: SquadExcludedCandidate[] = classification.recommendedAgents
    .filter((id) => !orderSet.has(id))
    .map((id) => ({ id, reason: 'level_filtered' as const }));
  const composition: SquadComposition = {
    level: classification.progressiveRefinement?.recommendedLevel ?? 3,
    excluded,
  };

  const edges: SquadEdge[] = [];

  const present = new Set(order);
  const rank = new Map(order.map((id, i) => [id, i]));
  const consistent = (from: string, to: string): boolean =>
    present.has(from) && present.has(to) && (rank.get(from) ?? -1) < (rank.get(to) ?? -1);

  const addEdge = (from: string, to: string, reason: SquadEdgeReason): void => {
    if (from === to) return;
    if (!consistent(from, to)) return;
    if (edges.some((e) => e.from === from && e.to === to)) return;
    edges.push({ from, to, reason });
  };

  if (present.has('product_owner')) {
    for (const agent of order) addEdge('product_owner', agent, 'po_first');
  }

  if (classification.category === 'technical') {
    addEdge('tech_lead', 'qa', 'tech_lead_before_qa');
  }

  if (classification.category === 'business' && present.has('product_manager')) {
    for (const agent of order) addEdge('product_manager', agent, 'pm_first_business');
  }

  if (classification.criteria.complexity > 70 && present.has('scrum_master')) {
    for (const agent of order) addEdge(agent, 'scrum_master', 'scrum_master_last');
  }

  return { nodes, edges, composition };
}

export function linearizeSquadGraph(graph: SquadGraph, tieBreak?: string[]): string[] {
  const ids = graph.nodes.filter((n) => n.kind === 'agent').map((n) => n.id);
  const agentSet = new Set(ids);
  const order = tieBreak ?? ids;
  const rank = new Map(order.map((id, i) => [id, i]));
  const rankOf = (id: string): number => rank.get(id) ?? Number.MAX_SAFE_INTEGER;

  const inDegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!agentSet.has(edge.from) || !agentSet.has(edge.to)) continue;
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    const list = adjacency.get(edge.from);
    if (list) list.push(edge.to);
    else adjacency.set(edge.from, [edge.to]);
  }

  const available = new Set(ids.filter((id) => (inDegree.get(id) ?? 0) === 0));
  const result: string[] = [];

  while (available.size > 0) {
    let pick: string | null = null;
    for (const id of available) {
      if (pick === null || rankOf(id) < rankOf(pick)) pick = id;
    }
    if (pick === null) break;
    available.delete(pick);
    result.push(pick);
    for (const to of adjacency.get(pick) ?? []) {
      const next = (inDegree.get(to) ?? 0) - 1;
      inDegree.set(to, next);
      if (next === 0) available.add(to);
    }
  }

  if (result.length !== ids.length) {
    const seen = new Set(result);
    const remaining = ids.filter((id) => !seen.has(id)).sort((a, b) => rankOf(a) - rankOf(b));
    return [...result, ...remaining];
  }

  return result;
}

export function graphPreservesOrder(
  classification: DemandClassification,
  order: string[],
): boolean {
  const linearized = linearizeSquadGraph(buildSquadGraph(classification, order), order);
  return linearized.length === order.length && linearized.every((id, i) => id === order[i]);
}

export function withDeliberationNode(
  graph: SquadGraph,
  participants: string[],
  nodeId: string = DELIBERATION_NODE_ID,
): SquadGraph {
  if (graph.nodes.some((n) => n.id === nodeId)) return graph;

  const agentIds = new Set(graph.nodes.filter((n) => n.kind === 'agent').map((n) => n.id));
  const edges: SquadEdge[] = [...graph.edges];
  for (const participant of participants) {
    if (!agentIds.has(participant)) continue;
    if (edges.some((e) => e.from === participant && e.to === nodeId)) continue;
    edges.push({ from: participant, to: nodeId, reason: 'feeds_deliberation' });
  }

  return {
    ...graph,
    nodes: [...graph.nodes, { id: nodeId, kind: 'deliberation' }],
    edges,
  };
}

export function buildDeliberationGraph(
  participants: string[],
  nodeId: string = DELIBERATION_NODE_ID,
): SquadGraph {
  const unique = Array.from(new Set(participants));
  const nodes: SquadNode[] = unique.map((id) => ({ id, kind: 'agent' }));
  const edges: SquadEdge[] = unique.map((id) => ({
    from: id,
    to: nodeId,
    reason: 'feeds_deliberation' as const,
  }));
  nodes.push({ id: nodeId, kind: 'deliberation' });
  return { nodes, edges };
}
