/**
 * Shared framework types.
 *
 * These types live in `shared/` so they can be referenced by both server
 * framework logic and shared contracts (e.g., the `Demand` type in
 * `shared/schema.ts`) without breaking the `shared ↔ client/server` boundary.
 */

export type FrameworkType =
  | 'jtbd'
  | 'heart'
  | 'severity-priority'
  | 'double-diamond'
  | 'crisp-dm'
  | 'threat-modeling'
  | 'privacy-by-design'
  | 'incremental-refactoring'
  | 'architecture-decision-record'
  | 'checklist'
  | 'auto-suggest';

export interface FrameworkMetrics {
  successRate: number;
  completionTime: number;
  stakeholderSatisfaction: number;
  costEfficiency: number;
  qualityScore: number;
}

export interface FrameworkIntegration {
  aiEnabled: boolean;
  externalTools: string[];
  apiEndpoints: string[];
  dataSources: string[];
}

export interface FrameworkExecutionResult {
  frameworkId: string;
  frameworkName?: string;
  demandId?: number;
  frameworkType?: FrameworkType;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  progress: number;
  metrics: FrameworkMetrics;
  outputs: Record<string, unknown>;
  timeline: {
    startedAt: string;
    completedAt?: string;
    duration?: number;
  };
  teamMembers: string[];
  resourcesUsed: string[];
}
