/**
 * Agregação de custo por agente/ferramenta/modelo para uma demanda (spec 008 / US4).
 *
 * Problema original (QA 006-04): `/api/demands/:id/costs` retornava `byAgent: {}`
 * e `byTool: {}` porque só reconhecia o prefixo `agent_interaction:`, enquanto os
 * fluxos reais gravam variantes (`agent:<nome>`, `agent_execution:<nome>`,
 * `roundtable:<nome>:turnN`, ...). Este módulo centraliza o parsing dos rótulos
 * de `operation` e declara explicitamente o custo não atribuível em
 * `unattributed`, em vez de deixá-lo desaparecer em silêncio.
 *
 * Contrato: specs/008-correcoes-pos-qa-005-006-007/contracts/cost-breakdown-contract.md
 */
/**
 * Entrada mínima do agregador. Tanto os registros em memória (`AIUsageRecord`)
 * quanto as linhas duráveis de `llm_audit_logs` (spec 10056) satisfazem este
 * shape — o agregador só depende destes quatro campos.
 */
export interface DemandUsageRecord {
  model: string;
  operation: string;
  estimatedCostUsd: number | null;
  totalTokens: number;
}

export interface CostAggregate {
  cost: number;
  tokens: number;
  count: number;
}

export interface DemandCostAggregation {
  byAgent: Record<string, CostAggregate>;
  byTool: Record<string, CostAggregate>;
  byModel: Record<string, CostAggregate>;
  /** Registros cujo `operation` não pôde ser associado a agente nem ferramenta. */
  unattributed: CostAggregate;
}

/**
 * Prefixos de `operation` que identificam uma chamada feita em nome de um
 * agente/ator LLM. O primeiro segmento após o prefixo é o nome do ator;
 * sufixos de fase (`:streaming`, `:reflection`, `:turn2`, ...) são agregados
 * sob o mesmo ator.
 *
 * Formatos reconhecidos (fonte: grep de `operation:` no server):
 *   agent_interaction:<agente>            server/services/agent-interaction.ts
 *   agent_execution:<agente>              server/services/agent-interaction.ts
 *   agent:<agente>[:streaming|:reflection] server/services/ai-squad.ts
 *   roundtable:<ator>[:turnN|...]          server/services/ai-squad/roundtable-orchestrator.ts
 */
const AGENT_OPERATION_PREFIXES = [
  'agent_interaction:',
  'agent_execution:',
  'agent:',
  'roundtable:',
];

const TOOL_OPERATION_PREFIX = 'tool:';

/** Extrai o nome do ator de um rótulo de agente, ou null se não for de agente. */
export function parseAgentFromOperation(operation: string): string | null {
  for (const prefix of AGENT_OPERATION_PREFIXES) {
    if (operation.startsWith(prefix)) {
      const actor = operation.slice(prefix.length).split(':')[0]?.trim();
      return actor && actor.length > 0 ? actor : null;
    }
  }
  return null;
}

/** Extrai o nome da ferramenta de um rótulo `tool:<nome>`, ou null. */
export function parseToolFromOperation(operation: string): string | null {
  if (!operation.startsWith(TOOL_OPERATION_PREFIX)) return null;
  const tool = operation.slice(TOOL_OPERATION_PREFIX.length).split(':')[0]?.trim();
  return tool && tool.length > 0 ? tool : null;
}

function add(
  bucket: Record<string, CostAggregate>,
  key: string,
  cost: number,
  tokens: number,
): void {
  if (!bucket[key]) bucket[key] = { cost: 0, tokens: 0, count: 0 };
  bucket[key].cost += cost;
  bucket[key].tokens += tokens;
  bucket[key].count += 1;
}

/**
 * Agrega registros de uso de uma demanda em byAgent/byTool/byModel/unattributed.
 *
 * Invariante do contrato: soma(byAgent) + soma(byTool) + unattributed ≈ totalCost
 * (byModel é uma dimensão paralela — todo registro entra em byModel).
 */
export function aggregateDemandCosts(records: DemandUsageRecord[]): DemandCostAggregation {
  const byAgent: Record<string, CostAggregate> = {};
  const byTool: Record<string, CostAggregate> = {};
  const byModel: Record<string, CostAggregate> = {};
  const unattributed: CostAggregate = { cost: 0, tokens: 0, count: 0 };

  for (const record of records) {
    const cost = record.estimatedCostUsd || 0;
    const tokens = record.totalTokens;

    add(byModel, record.model, cost, tokens);

    const agent = parseAgentFromOperation(record.operation);
    if (agent) {
      add(byAgent, agent, cost, tokens);
      continue;
    }

    const tool = parseToolFromOperation(record.operation);
    if (tool) {
      add(byTool, tool, cost, tokens);
      continue;
    }

    unattributed.cost += cost;
    unattributed.tokens += tokens;
    unattributed.count += 1;
  }

  return { byAgent, byTool, byModel, unattributed };
}
