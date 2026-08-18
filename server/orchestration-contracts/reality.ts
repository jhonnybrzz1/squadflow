/**
 * Contrato de abstração para RealityBasedRefinement.
 *
 * Permite que ai-squad/context-assembler dependa da interface sem importar a
 * implementação concreta de cognitive-core, quebrando o ciclo correspondente.
 */

export interface RealityConstraintSet {
  maturityLevel: string;
  demandType: string;
  canonicalDemandType?: string;
  allowedTechnologies: string[];
  forbiddenTechnologies: string[];
  maxEffortDays: number;
  minROI: string;
  outputType?: string;
  typeRequirements: readonly string[];
  stack?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
}

export interface IRealityBasedRefinement {
  getConstraintsForDemandType(demandType: string): Promise<RealityConstraintSet>;
}
