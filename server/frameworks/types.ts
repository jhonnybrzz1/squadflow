// Framework Types and Interfaces
// Base types for all demand management frameworks

import type {
  FrameworkType,
  FrameworkMetrics,
  FrameworkIntegration,
  FrameworkExecutionResult,
} from '@shared/framework-types';

export type { FrameworkType, FrameworkMetrics, FrameworkIntegration, FrameworkExecutionResult };

/** Espelha os membros de FrameworkType para validação em runtime (a union some no build). */
export const KNOWN_FRAMEWORK_TYPES: readonly FrameworkType[] = [
  'jtbd',
  'heart',
  'severity-priority',
  'double-diamond',
  'crisp-dm',
  'threat-modeling',
  'privacy-by-design',
  'incremental-refactoring',
  'architecture-decision-record',
  'checklist',
  'auto-suggest',
];

// Base interface for all frameworks
export interface BaseFramework {
  id: string;
  name: string;
  description: string;
  type: FrameworkType;
  version: string;
  createdAt: string;
  updatedAt: string;
  /** Status de implementação do framework. 'stub' indica registro placeholder. */
  status?: 'implemented' | 'stub';
}

// JTBD Framework - Jobs-to-be-Done
export interface JTBDFramework extends BaseFramework {
  type: 'jtbd';
  jobStatement: string;
  jobSteps: string[];
  desiredOutcomes: string[];
  constraints: string[];
  successMetrics: {
    jobCompletionRate: number;
    customerSatisfaction: number;
    timeToComplete: number;
  };
  integration: FrameworkIntegration & {
    customerInterviews: boolean;
    surveyTools: string[];
  };
}

// HEART Framework - UX Metrics
export interface HEARTFramework extends BaseFramework {
  type: 'heart';
  happiness: {
    currentScore: number;
    targetScore: number;
    measurementMethod: string;
  };
  engagement: {
    currentScore: number;
    targetScore: number;
    measurementMethod: string;
  };
  adoption: {
    currentScore: number;
    targetScore: number;
    measurementMethod: string;
  };
  retention: {
    currentScore: number;
    targetScore: number;
    measurementMethod: string;
  };
  taskSuccess: {
    currentScore: number;
    targetScore: number;
    measurementMethod: string;
  };
  uxMetrics: {
    usabilityScore: number;
    accessibilityScore: number;
    userFeedback: string[];
  };
  integration: FrameworkIntegration & {
    analyticsTools: string[];
    sessionRecording: boolean;
    heatmapTools: string[];
  };
}

// Severity x Priority Matrix
export interface SeverityPriorityFramework extends BaseFramework {
  type: 'severity-priority';
  severityLevels: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  priorityLevels: {
    immediate: number;
    urgent: number;
    high: number;
    medium: number;
    low: number;
  };
  matrix: {
    [severity: string]: {
      [priority: string]: {
        action: string;
        sla: string;
        team: string;
      };
    };
  };
  bugMetrics: {
    resolutionTime: number;
    reopenRate: number;
    customerImpact: number;
  };
  integration: FrameworkIntegration & {
    bugTracking: string[];
    monitoringTools: string[];
    alertingSystems: string[];
  };
}

// Double Diamond Framework
export interface DoubleDiamondFramework extends BaseFramework {
  type: 'double-diamond';
  discoverPhase: {
    researchMethods: string[];
    insights: string[];
    userNeeds: string[];
    painPoints: string[];
  };
  definePhase: {
    problemStatements: string[];
    userJourneys: string[];
    personas: string[];
  };
  developPhase: {
    ideationMethods: string[];
    prototypes: string[];
    iterations: string[];
  };
  deliverPhase: {
    testingMethods: string[];
    launchPlan: string;
    feedbackCollection: string[];
  };
  integration: FrameworkIntegration & {
    designTools: string[];
    collaborationTools: string[];
  };
}

// CRISP-DM Framework
export interface CRISPDMFramework extends BaseFramework {
  type: 'crisp-dm';
  businessUnderstanding: {
    businessObjectives: string[];
    successCriteria: string[];
    constraints: string[];
  };
  dataUnderstanding: {
    dataSources: string[];
    dataQuality: string;
    initialFindings: string[];
  };
  dataPreparation: {
    cleaningSteps: string[];
    featureEngineering: string[];
    dataTransformation: string[];
  };
  modeling: {
    algorithms: string[];
    modelParameters: Record<string, unknown>;
    validationMethod: string;
  };
  evaluation: {
    metrics: string[];
    businessImpact: string;
    recommendations: string[];
  };
  deployment: {
    deploymentStrategy: string;
    monitoringPlan: string;
    maintenancePlan: string;
  };
  integration: FrameworkIntegration & {
    mlLibraries: string[];
    visualizationTools: string[];
  };
}

// AI Framework Suggestion
export interface AIFrameworkSuggestion extends BaseFramework {
  type: 'auto-suggest';
  analysisCriteria: FrameworkSelectionCriteria;
  suggestedFrameworks: {
    primary: FrameworkType;
    secondary: FrameworkType[];
    rationale: string;
  };
  confidenceScore: number;
  alternativeOptions: {
    framework: FrameworkType;
    score: number;
    rationale: string;
  }[];
  integration: FrameworkIntegration & {
    aiModels: string[];
    knowledgeBases: string[];
    decisionEngines: string[];
  };
}

// Stub Framework — placeholder para frameworks declarados em DEMAND_TYPES
// que ainda não possuem implementação específica.
export interface StubFramework extends BaseFramework {
  type:
    | 'threat-modeling'
    | 'privacy-by-design'
    | 'incremental-refactoring'
    | 'architecture-decision-record'
    | 'checklist';
}

// Union type for all frameworks
export type AnyFramework =
  | JTBDFramework
  | HEARTFramework
  | SeverityPriorityFramework
  | DoubleDiamondFramework
  | CRISPDMFramework
  | StubFramework
  | AIFrameworkSuggestion;

// Framework selection criteria
export interface FrameworkSelectionCriteria {
  demandType: string;
  complexity: 'low' | 'medium' | 'high' | 'very-high';
  impact: 'low' | 'medium' | 'high' | 'critical';
  urgency: 'low' | 'medium' | 'high' | 'immediate' | 'urgent';
  teamSize: 'small' | 'medium' | 'large' | 'enterprise';
  budget: 'limited' | 'moderate' | 'high' | 'unlimited';
  timeline: 'short' | 'medium' | 'long' | 'ongoing';
  industry: string;
  stakeholders: string[];
}

// Framework recommendation result
export interface FrameworkRecommendation {
  recommendedFramework: FrameworkType;
  confidence: number; // 0-100
  rationale: string;
  implementationSteps: string[];
  expectedOutcomes: string[];
  successMetrics: FrameworkMetrics;
  integrationRequirements: FrameworkIntegration;
}
