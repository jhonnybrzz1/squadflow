/**
 * Contratos de output do cognitive-core.
 *
 * Extraídos de cognitive-core/cognitive-config-adapter.ts para que ai-squad
 * possa consumir o output sem importar do cognitive-core.
 */

export interface CognitiveCoreConstraint {
  name: string;
  severity: string;
  description?: string;
}

export interface CognitiveCoreSpecialist {
  agentId: string;
  role: string;
  priority: number;
}

export interface CognitiveCoreOutput {
  demandId: number;
  classification: {
    type: string;
    category?: string;
    confidence: number;
  };
  constraints: CognitiveCoreConstraint[];
  specialists: CognitiveCoreSpecialist[];
  framework: string;
  numericFields: {
    maxEffortDays: number;
    maxRounds: number;
    confidence: number;
  };
}
