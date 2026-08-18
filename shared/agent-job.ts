/**
 * Contrato do passo a passo da atuação do agente de código (spec 10064 Batch 2).
 * Fonte única backend↔front. O parser (server) produz `AgentJobStep[]`; o front
 * consome via `AgentJobView` (a linha de `agent_jobs` + os passos).
 */

/** Um passo legível da atuação do agente. */
export interface AgentJobStep {
  /** Categoria do passo — dirige o ícone/estilo no front. */
  kind: 'tool' | 'text' | 'result' | 'error';
  /** Rótulo curto e legível (ex.: "Edit server/foo.ts"). */
  label: string;
  /** Detalhe opcional (ex.: comando completo, trecho de texto). */
  detail?: string;
}

/** Job do agente exposto ao front (espelha `AgentJob` + `steps`). */
export interface AgentJobView {
  id: string;
  demandId: number;
  speckitPath: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  filesModified: string[];
  typecheckPassed: boolean | null;
  apiCostUsd: number | null;
  humanEditsCount: number;
  cancelledAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  steps: AgentJobStep[];
}
