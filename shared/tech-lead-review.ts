/**
 * Spec "Ajustes claude" F2 — contrato do parecer do TechLead sobre a atuação do
 * agente Claude. Incremento OPCIONAL: quando falha, o front NÃO
 * bloqueia o fluxo de relatório (fallback).
 */

/** Parecer sintético do TechLead, renderizável como markdown no front (F1). */
export interface TechLeadReview {
  /** Execução do Claude efetivamente avaliada (recurso principal do parecer). */
  jobId: string;
  /** Demanda de origem, exposta apenas como contexto da execução. */
  demandId: number;
  /** Texto do parecer em markdown. */
  parecer: string;
  /** Modelo que produziu o parecer, quando conhecido. */
  model: string | null;
  generatedAt: string;
}
