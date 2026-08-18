import { ProjectReality } from './project-reality-reader';
import { getDemandTypeConfig } from '@shared/demand-types';

interface DemandTypeConstraints {
  bug: {
    maxTechnicalDepth: number;
    canAssumeNewTech: boolean;
    maxArchitectureChanges: number;
  };
  discovery: {
    maxHypotheses: number;
    canExploreFutureTech: boolean;
    mustUseCurrentStack: boolean;
  };
  newFeature: {
    maxScope: 'incremental' | 'moderate' | 'large';
    canIntroduceNewTech: boolean;
    maxNewDependencies: number;
  };
  improvement: {
    maxOptimizationLevel: 'minor' | 'moderate' | 'major';
    canRefactorArchitecture: boolean;
    mustMaintainCompatibility: boolean;
  };
  exploratoryAnalysis: {
    maxExplorationScope: 'current' | 'adjacent' | 'future';
    canProposeFutureTech: boolean;
    mustGroundInReality: boolean;
  };
  security: {
    maxThreatScenarios: number;
    requireComplianceReview: boolean;
    maxNewExternalServices: number;
  };
  refactoring: {
    maxFilesChanged: number;
    allowArchitectureChange: boolean;
    mustPreserveBehavior: boolean;
  };
  infrastructure: {
    maxNewComponents: number;
    requireObservabilityPlan: boolean;
    allowMultiRegion: boolean;
  };
}

type CanonicalDemandType = keyof DemandTypeConstraints;

export interface BaseConstraints {
  maturityLevel: ProjectReality['maturityLevel'];
  capabilities: ProjectReality['capabilities'];
  stack: ProjectReality['stack'];
  allowedTechnologies: string[];
  forbiddenTechnologies: string[];
}

export interface ExecutionConstraints {
  maxEffortDays: number;
  minROI: string;
  outputType: string;
  typeRequirements: readonly string[];
}

export interface FullConstraints extends BaseConstraints {
  demandType: string;
  canonicalDemandType: CanonicalDemandType;
  maxEffortDays: number;
  minROI: string;
  outputType: string;
  typeRequirements: readonly string[];
  // Limites específicos por tipo de demanda (bug/newFeature), definidos em
  // getConstraintsForDemandType; opcionais pois nem todo tipo os usa.
  maxTechnicalDepth?: number;
  maxArchitectureChanges?: number;
  maxNewDependencies?: number;
  maxThreatScenarios?: number;
  requireComplianceReview?: boolean;
  maxNewExternalServices?: number;
  maxFilesChanged?: number;
  allowArchitectureChange?: boolean;
  mustPreserveBehavior?: boolean;
  maxNewComponents?: number;
  requireObservabilityPlan?: boolean;
  allowMultiRegion?: boolean;
  // CRIT-14: constraints dos 3 tipos que faltavam no switch de checkAdherence.
  maxHypotheses?: number;
  canExploreFutureTech?: boolean;
  mustUseCurrentStack?: boolean;
  maxOptimizationLevel?: 'minor' | 'moderate' | 'major';
  canRefactorArchitecture?: boolean;
  mustMaintainCompatibility?: boolean;
  maxExplorationScope?: 'current' | 'adjacent' | 'future';
  canProposeFutureTech?: boolean;
  mustGroundInReality?: boolean;
}

export interface DemandAnalysis {
  technologies?: string[];
  technicalDepth?: number;
  architectureChanges?: number;
  newDependencies?: number;
  threatScenarios?: number;
  complianceReviewIncluded?: boolean;
  newExternalServices?: number;
  filesChanged?: number;
  architectureChangeRequested?: boolean;
  preservesBehavior?: boolean;
  newComponents?: number;
  observabilityPlanIncluded?: boolean;
  multiRegionDeployment?: boolean;
  // CRIT-14: campos de análise para os 3 tipos que faltavam no switch.
  hypothesesCount?: number;
  exploresFutureTech?: boolean;
  usesCurrentStack?: boolean;
  optimizationLevel?: 'minor' | 'moderate' | 'major';
  refactorsArchitecture?: boolean;
  maintainsCompatibility?: boolean;
  explorationScope?: 'current' | 'adjacent' | 'future';
  proposesFutureTech?: boolean;
  groundedInReality?: boolean;
}

export class RealityConstraints {
  private projectReality: ProjectReality;

  constructor(projectReality: ProjectReality) {
    this.projectReality = projectReality;
  }

  public getConstraintsForDemandType(demandType: string): FullConstraints {
    const baseConstraints = this.getBaseConstraints();
    const config = getDemandTypeConfig(demandType);
    const canonicalDemandType = config.canonicalDemandType as CanonicalDemandType;
    const specificConstraints = this.getSpecificConstraints(canonicalDemandType);
    const executionConstraints = this.getExecutionConstraints(demandType);

    return {
      ...baseConstraints,
      ...specificConstraints,
      ...executionConstraints,
      demandType,
      canonicalDemandType,
    };
  }

  private getBaseConstraints(): {
    maturityLevel: ProjectReality['maturityLevel'];
    capabilities: ProjectReality['capabilities'];
    stack: ProjectReality['stack'];
    allowedTechnologies: string[];
    forbiddenTechnologies: string[];
  } {
    const allowedTechnologies = [
      ...this.projectReality.stack.frontend,
      ...this.projectReality.stack.backend,
      ...this.projectReality.stack.database,
      ...this.projectReality.stack.infrastructure,
      ...this.projectReality.stack.ai,
    ];

    const forbiddenTechnologies = this.getForbiddenTechnologies();

    return {
      maturityLevel: this.projectReality.maturityLevel,
      capabilities: this.projectReality.capabilities,
      stack: this.projectReality.stack,
      allowedTechnologies,
      forbiddenTechnologies,
    };
  }

  private getForbiddenTechnologies(): string[] {
    const forbidden: string[] = [];

    // Based on maturity level - lista reduzida, foco em complexidade operacional
    // NÃO bloquear tecnologias apenas por serem "avançadas"
    switch (this.projectReality.maturityLevel) {
      case 'MVP':
        // Apenas bloquear complexidade operacional pesada
        forbidden.push(
          'Kubernetes', // Complexidade operacional alta
          'Multi-region deployment', // Complexidade operacional
        );
        break;

      case 'Initial Product':
        forbidden.push('Multi-region deployment');
        break;

      case 'Scaling Product':
        // Scaling Product pode usar qualquer tecnologia
        break;
    }

    // Capabilities-based: apenas bloquear se realmente não há capacidade
    // E mesmo assim, permitir como "proposta a avaliar"
    if (!this.projectReality.capabilities.structuredAI) {
      forbidden.push('Custom ML Training'); // Treino customizado requer infra
    }

    return forbidden;
  }

  private getSpecificConstraints(
    demandType: CanonicalDemandType,
  ):
    | DemandTypeConstraints['bug']
    | DemandTypeConstraints['discovery']
    | DemandTypeConstraints['newFeature']
    | DemandTypeConstraints['improvement']
    | DemandTypeConstraints['exploratoryAnalysis']
    | DemandTypeConstraints['security']
    | DemandTypeConstraints['refactoring']
    | DemandTypeConstraints['infrastructure']
    | Record<string, never> {
    switch (demandType) {
      case 'bug':
        return this.getBugConstraints();
      case 'discovery':
        return this.getDiscoveryConstraints();
      case 'newFeature':
        return this.getNewFeatureConstraints();
      case 'improvement':
        return this.getImprovementConstraints();
      case 'exploratoryAnalysis':
        return this.getExploratoryAnalysisConstraints();
      case 'security':
        return this.getSecurityConstraints();
      case 'refactoring':
        return this.getRefactoringConstraints();
      case 'infrastructure':
        return this.getInfrastructureConstraints();
      default:
        return {};
    }
  }

  private getExecutionConstraints(demandType: string): ExecutionConstraints {
    const config = getDemandTypeConfig(demandType);
    return {
      maxEffortDays: config.maxEffortDays,
      minROI: config.minROI,
      outputType: config.outputType,
      typeRequirements: config.typeRequirements,
    };
  }

  private getBugConstraints(): DemandTypeConstraints['bug'] {
    switch (this.projectReality.maturityLevel) {
      case 'MVP':
        return {
          maxTechnicalDepth: 2,
          canAssumeNewTech: false,
          maxArchitectureChanges: 0,
        };
      case 'Initial Product':
        return {
          maxTechnicalDepth: 3,
          canAssumeNewTech: false,
          maxArchitectureChanges: 1,
        };
      case 'Scaling Product':
        return {
          maxTechnicalDepth: 4,
          canAssumeNewTech: true,
          maxArchitectureChanges: 2,
        };
      default:
        return {
          maxTechnicalDepth: 2,
          canAssumeNewTech: false,
          maxArchitectureChanges: 0,
        };
    }
  }

  private getDiscoveryConstraints(): DemandTypeConstraints['discovery'] {
    // Discovery é exploratório por natureza - permitir mais liberdade
    switch (this.projectReality.maturityLevel) {
      case 'MVP':
        return {
          maxHypotheses: 5,
          canExploreFutureTech: true, // Discovery pode explorar, mesmo em MVP
          mustUseCurrentStack: false, // Pode propor alternativas com trade-offs
        };
      case 'Initial Product':
        return {
          maxHypotheses: 7,
          canExploreFutureTech: true,
          mustUseCurrentStack: false,
        };
      case 'Scaling Product':
        return {
          maxHypotheses: 10,
          canExploreFutureTech: true,
          mustUseCurrentStack: false,
        };
      default:
        return {
          maxHypotheses: 5,
          canExploreFutureTech: true,
          mustUseCurrentStack: false,
        };
    }
  }

  private getNewFeatureConstraints(): DemandTypeConstraints['newFeature'] {
    // New Feature pode inovar quando justificado
    switch (this.projectReality.maturityLevel) {
      case 'MVP':
        return {
          maxScope: 'moderate', // MVP pode ter escopo moderado se justificado
          canIntroduceNewTech: true, // Pode introduzir tech nova com trade-offs claros
          maxNewDependencies: 2,
        };
      case 'Initial Product':
        return {
          maxScope: 'large',
          canIntroduceNewTech: true,
          maxNewDependencies: 3,
        };
      case 'Scaling Product':
        return {
          maxScope: 'large',
          canIntroduceNewTech: true,
          maxNewDependencies: 5,
        };
      default:
        return {
          maxScope: 'moderate',
          canIntroduceNewTech: true,
          maxNewDependencies: 2,
        };
    }
  }

  private getImprovementConstraints(): DemandTypeConstraints['improvement'] {
    // Improvement pode envolver refatoração quando necessário
    switch (this.projectReality.maturityLevel) {
      case 'MVP':
        return {
          maxOptimizationLevel: 'moderate', // MVP pode ter otimização moderada
          canRefactorArchitecture: true, // Pode refatorar se justificado
          mustMaintainCompatibility: true,
        };
      case 'Initial Product':
        return {
          maxOptimizationLevel: 'major',
          canRefactorArchitecture: true,
          mustMaintainCompatibility: true,
        };
      case 'Scaling Product':
        return {
          maxOptimizationLevel: 'major',
          canRefactorArchitecture: true,
          mustMaintainCompatibility: false,
        };
      default:
        return {
          maxOptimizationLevel: 'moderate',
          canRefactorArchitecture: true,
          mustMaintainCompatibility: true,
        };
    }
  }

  private getExploratoryAnalysisConstraints(): DemandTypeConstraints['exploratoryAnalysis'] {
    // Exploratory Analysis é investigativo - permitir liberdade para explorar
    switch (this.projectReality.maturityLevel) {
      case 'MVP':
        return {
          maxExplorationScope: 'adjacent', // MVP pode explorar adjacências
          canProposeFutureTech: true, // Pode propor tech futura como opção
          mustGroundInReality: false, // Exploração pode ser especulativa
        };
      case 'Initial Product':
        return {
          maxExplorationScope: 'future',
          canProposeFutureTech: true,
          mustGroundInReality: false,
        };
      case 'Scaling Product':
        return {
          maxExplorationScope: 'future',
          canProposeFutureTech: true,
          mustGroundInReality: false,
        };
      default:
        return {
          maxExplorationScope: 'adjacent',
          canProposeFutureTech: true,
          mustGroundInReality: false,
        };
    }
  }

  private getSecurityConstraints(): DemandTypeConstraints['security'] {
    switch (this.projectReality.maturityLevel) {
      case 'MVP':
        return { maxThreatScenarios: 3, requireComplianceReview: true, maxNewExternalServices: 0 };
      case 'Initial Product':
        return { maxThreatScenarios: 5, requireComplianceReview: true, maxNewExternalServices: 1 };
      case 'Scaling Product':
        return { maxThreatScenarios: 8, requireComplianceReview: true, maxNewExternalServices: 2 };
      default:
        return { maxThreatScenarios: 3, requireComplianceReview: true, maxNewExternalServices: 0 };
    }
  }

  private getRefactoringConstraints(): DemandTypeConstraints['refactoring'] {
    switch (this.projectReality.maturityLevel) {
      case 'MVP':
        return { maxFilesChanged: 8, allowArchitectureChange: false, mustPreserveBehavior: true };
      case 'Initial Product':
        return { maxFilesChanged: 15, allowArchitectureChange: true, mustPreserveBehavior: true };
      case 'Scaling Product':
        return { maxFilesChanged: 30, allowArchitectureChange: true, mustPreserveBehavior: true };
      default:
        return { maxFilesChanged: 8, allowArchitectureChange: false, mustPreserveBehavior: true };
    }
  }

  private getInfrastructureConstraints(): DemandTypeConstraints['infrastructure'] {
    switch (this.projectReality.maturityLevel) {
      case 'MVP':
        return { maxNewComponents: 2, requireObservabilityPlan: true, allowMultiRegion: false };
      case 'Initial Product':
        return { maxNewComponents: 4, requireObservabilityPlan: true, allowMultiRegion: false };
      case 'Scaling Product':
        return { maxNewComponents: 8, requireObservabilityPlan: true, allowMultiRegion: true };
      default:
        return { maxNewComponents: 2, requireObservabilityPlan: true, allowMultiRegion: false };
    }
  }

  public checkAdherence(
    demandAnalysis: DemandAnalysis,
    demandType: string,
  ): {
    isAdherent: boolean;
    issues: string[];
    adherenceScore: number;
  } {
    const config = getDemandTypeConfig(demandType);
    const canonicalDemandType = config.canonicalDemandType as CanonicalDemandType;
    const constraints = this.getConstraintsForDemandType(demandType);
    const issues: string[] = [];

    // Check for forbidden technologies
    if (demandAnalysis.technologies) {
      const forbiddenTechUsed = demandAnalysis.technologies.filter((tech: string) =>
        constraints.forbiddenTechnologies.includes(tech),
      );

      if (forbiddenTechUsed.length > 0) {
        issues.push(`Forbidden technologies used: ${forbiddenTechUsed.join(', ')}`);
      }
    }

    // Check specific constraints based on demand type
    switch (canonicalDemandType) {
      case 'bug':
        if ((demandAnalysis.technicalDepth ?? 0) > (constraints.maxTechnicalDepth ?? Infinity)) {
          issues.push(
            `Technical depth ${demandAnalysis.technicalDepth} exceeds maximum of ${constraints.maxTechnicalDepth}`,
          );
        }
        if (
          (demandAnalysis.architectureChanges ?? 0) >
          (constraints.maxArchitectureChanges ?? Infinity)
        ) {
          issues.push(
            `Architecture changes ${demandAnalysis.architectureChanges} exceeds maximum of ${constraints.maxArchitectureChanges}`,
          );
        }
        break;

      case 'newFeature':
        if ((demandAnalysis.newDependencies ?? 0) > (constraints.maxNewDependencies ?? Infinity)) {
          issues.push(
            `New dependencies ${demandAnalysis.newDependencies} exceeds maximum of ${constraints.maxNewDependencies}`,
          );
        }
        break;

      case 'discovery':
        if ((demandAnalysis.hypothesesCount ?? 0) > (constraints.maxHypotheses ?? Infinity)) {
          issues.push(
            `Hypotheses ${demandAnalysis.hypothesesCount} exceeds maximum of ${constraints.maxHypotheses}`,
          );
        }
        if (
          constraints.canExploreFutureTech === false &&
          demandAnalysis.exploresFutureTech === true
        ) {
          issues.push('Exploring future tech is not allowed at this maturity level');
        }
        if (constraints.mustUseCurrentStack === true && demandAnalysis.usesCurrentStack === false) {
          issues.push('Discovery must use the current stack at this maturity level');
        }
        break;

      case 'improvement': {
        const optRank: Record<string, number> = { minor: 0, moderate: 1, major: 2 };
        const maxOptRank = optRank[constraints.maxOptimizationLevel ?? 'major'] ?? 2;
        const actualOptRank = optRank[demandAnalysis.optimizationLevel ?? 'minor'] ?? 0;
        if (actualOptRank > maxOptRank) {
          issues.push(
            `Optimization level ${demandAnalysis.optimizationLevel} exceeds maximum of ${constraints.maxOptimizationLevel}`,
          );
        }
        if (
          constraints.canRefactorArchitecture === false &&
          demandAnalysis.refactorsArchitecture === true
        ) {
          issues.push('Architecture refactor is not allowed at this maturity level');
        }
        if (
          constraints.mustMaintainCompatibility === true &&
          demandAnalysis.maintainsCompatibility === false
        ) {
          issues.push('Improvement must maintain backward compatibility');
        }
        break;
      }

      case 'exploratoryAnalysis': {
        const scopeRank: Record<string, number> = { current: 0, adjacent: 1, future: 2 };
        const maxScopeRank = scopeRank[constraints.maxExplorationScope ?? 'future'] ?? 2;
        const actualScopeRank = scopeRank[demandAnalysis.explorationScope ?? 'current'] ?? 0;
        if (actualScopeRank > maxScopeRank) {
          issues.push(
            `Exploration scope ${demandAnalysis.explorationScope} exceeds maximum of ${constraints.maxExplorationScope}`,
          );
        }
        if (
          constraints.canProposeFutureTech === false &&
          demandAnalysis.proposesFutureTech === true
        ) {
          issues.push('Proposing future tech is not allowed at this maturity level');
        }
        if (
          constraints.mustGroundInReality === true &&
          demandAnalysis.groundedInReality === false
        ) {
          issues.push('Exploratory analysis must be grounded in current reality');
        }
        break;
      }

      case 'security':
        if ((demandAnalysis.threatScenarios ?? 0) > (constraints.maxThreatScenarios ?? Infinity)) {
          issues.push(
            `Threat scenarios ${demandAnalysis.threatScenarios} exceeds maximum of ${constraints.maxThreatScenarios}`,
          );
        }
        if (
          constraints.requireComplianceReview === true &&
          demandAnalysis.complianceReviewIncluded === false
        ) {
          issues.push('Compliance review is required for security demands');
        }
        if (
          (demandAnalysis.newExternalServices ?? 0) >
          (constraints.maxNewExternalServices ?? Infinity)
        ) {
          issues.push(
            `New external services ${demandAnalysis.newExternalServices} exceeds maximum of ${constraints.maxNewExternalServices}`,
          );
        }
        break;

      case 'refactoring':
        if ((demandAnalysis.filesChanged ?? 0) > (constraints.maxFilesChanged ?? Infinity)) {
          issues.push(
            `Files changed ${demandAnalysis.filesChanged} exceeds maximum of ${constraints.maxFilesChanged}`,
          );
        }
        if (
          demandAnalysis.architectureChangeRequested === true &&
          constraints.allowArchitectureChange === false
        ) {
          issues.push('Architecture change is not allowed for this maturity level');
        }
        if (
          constraints.mustPreserveBehavior === true &&
          demandAnalysis.preservesBehavior === false
        ) {
          issues.push('Refactoring must preserve behavior');
        }
        break;

      case 'infrastructure':
        if ((demandAnalysis.newComponents ?? 0) > (constraints.maxNewComponents ?? Infinity)) {
          issues.push(
            `New components ${demandAnalysis.newComponents} exceeds maximum of ${constraints.maxNewComponents}`,
          );
        }
        if (
          constraints.requireObservabilityPlan === true &&
          demandAnalysis.observabilityPlanIncluded === false
        ) {
          issues.push('Observability plan is required for infrastructure demands');
        }
        if (
          demandAnalysis.multiRegionDeployment === true &&
          constraints.allowMultiRegion === false
        ) {
          issues.push('Multi-region deployment is not allowed for this maturity level');
        }
        break;
    }

    const adherenceScore = Math.max(0, 100 - issues.length * 20);

    return {
      isAdherent: issues.length === 0,
      issues,
      adherenceScore,
    };
  }
}
