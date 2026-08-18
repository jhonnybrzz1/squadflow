/**
 * Contrato do breakdown de custos por demanda (spec 014 S2 / auditoria H-09).
 *
 * Invariante de reconciliação: totalCost ≈ Σ(byAgent) + Σ(byTool) + unattributed
 * dentro de COST_RECONCILIATION_TOLERANCE. `byModel` é uma dimensão paralela
 * (o mesmo registro aparece em agente/ferramenta E em modelo) e não entra na soma.
 */
export interface CostGroup {
  cost: number;
  tokens: number;
  count: number;
}

export interface CostBreakdownResponse {
  demandId: number;
  totalCost: number;
  tokensIn: number;
  tokensOut: number;
  totalRecords: number;
  byAgent: Record<string, CostGroup>;
  byTool: Record<string, CostGroup>;
  byModel: Record<string, CostGroup>;
  /** Custo cujos rótulos de operation não mapeiam para agente nem ferramenta. */
  unattributed: CostGroup;
  /**
   * Chamadas sem preço estimado (ex.: modelos sem pricing configurado). Elas
   * contribuem 0 ao custo — este campo torna a lacuna visível em vez de sumir
   * em silêncio. Opcional/aditivo (spec 10056); não entra na reconciliação.
   */
  unpriced?: { count: number; tokens: number };
}

/**
 * Tolerância documentada (research R3): cobre arredondamento de ponto
 * flutuante do agregador — max(1e-6, 0.5% do total).
 */
export function costReconciliationTolerance(totalCost: number): number {
  return Math.max(0.000001, Math.abs(totalCost) * 0.005);
}

export function isCostReconciled(breakdown: CostBreakdownResponse): boolean {
  const attributed =
    Object.values(breakdown.byAgent).reduce((sum, g) => sum + g.cost, 0) +
    Object.values(breakdown.byTool).reduce((sum, g) => sum + g.cost, 0) +
    breakdown.unattributed.cost;
  return (
    Math.abs(breakdown.totalCost - attributed) <= costReconciliationTolerance(breakdown.totalCost)
  );
}
