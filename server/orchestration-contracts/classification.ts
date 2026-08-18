/**
 * Contratos de classificação de demanda extraídos de cognitive-core/demand-classifier.
 *
 * São usados tanto pelo cognitive-core (classificador/orquestrador) quanto pelo
 * ai-squad (squad-graph, model-routing), portanto residem aqui para evitar
 * dependência circular.
 */

/** Rótulo de vaguidão usado pelo classificador híbrido. */
export type VaguenessLabel = 'vaga' | 'nao_vaga';

/** Método pelo qual o classificador híbrido chegou à decisão. */
export type ClassificationMethod = 'rule' | 'hybrid' | 'fallback';

/** Categorias de demanda produzidas pelo classificador. */
export type DemandCategory =
  'technical' | 'legal' | 'creative' | 'business' | 'analytical' | 'support' | 'research';

/** Critérios de classificação (0-100). */
export interface ClassificationCriteria {
  ambiguity: number;
  interpretationRisk: number;
  depthRequired: number;
  complexity: number;
  urgency: number;
}

export interface PersonalReadinessScore {
  score: number;
  level: 'ready' | 'needs_refinement' | 'blocked';
  blockers: string[];
  nextQuestions: string[];
  recommendation: string;
}

export interface ProgressiveRefinementTriage {
  recommendedLevel: 1 | 2 | 3;
  impact: 'low' | 'medium' | 'high';
  risk: 'low' | 'medium' | 'high';
  complexity: 'low' | 'medium' | 'high';
}

/** Contrato estendido do agente roteador (classificação híbrida). */
export interface RouterClassificationContract {
  tipo_demanda:
    | 'bug'
    | 'feature'
    | 'melhoria'
    | 'debito_tecnico'
    | 'discovery'
    | 'documentacao'
    | 'analise_tecnica'
    | 'security'
    | 'refactoring'
    | 'infraestrutura'
    | 'spike';
  area_responsavel?: string;
  complexidade: 'baixa' | 'media' | 'alta';
  risco: 'baixo' | 'medio' | 'alto';
  clareza_da_demanda: 'baixa' | 'media' | 'alta';
  impacto_negocio: 'baixo' | 'medio' | 'alto' | 'critico';
  necessita_codigo: boolean;
  necessita_arquitetura: boolean;
  necessita_ux: boolean;
  necessita_qa: boolean;
  necessita_prd: boolean;
  necessita_dados: boolean;
  modelo_recomendado: string;
  agentes_recomendados: string[];
  justificativa: string;
}

export interface HybridVaguenessInfo {
  label: VaguenessLabel;
  ruleScore: number;
  embeddingScore: number | null;
  method: ClassificationMethod;
  confidence: number;
  latencyMs: number;
  costUsd: number;
}

export interface DemandClassification {
  category: DemandCategory;
  criteria: ClassificationCriteria;
  confidence: number;
  recommendedAgents: string[];
  notes: string;
  personalReadiness: PersonalReadinessScore;
  progressiveRefinement?: ProgressiveRefinementTriage;
  hybridVagueness?: HybridVaguenessInfo;
  realityConstraints?: {
    maturityLevel: string;
    forbiddenTechnologies: string[];
    allowedTechnologies: string[];
    capabilities: string[];
  };
  routerContract?: RouterClassificationContract;
}
