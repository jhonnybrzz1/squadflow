import { ProjectReality } from './project-reality-reader';
import { RealityConstraints } from './reality-constraints';

export interface CompatibilityBlock {
  projectRealityUsed: {
    stack: ProjectReality['stack'];
    maturityLevel: ProjectReality['maturityLevel'];
    capabilities: ProjectReality['capabilities'];
  };
  adherenceToCurrentCode: 'High' | 'Medium' | 'Low';
  technicalExtrapolation: 'None' | 'Moderate' | 'High';
  constraintsApplied: {
    maturityLevel: ProjectReality['maturityLevel'];
    forbiddenTechnologies: string[];
    allowedTechnologies: string[];
  };
  adherenceScore: number;
  issuesFound: string[];
  generatedAt: string;
}

export class CompatibilityBlockGenerator {
  private projectReality: ProjectReality;
  private realityConstraints: RealityConstraints;

  constructor(projectReality: ProjectReality) {
    this.projectReality = projectReality;
    this.realityConstraints = new RealityConstraints(projectReality);
  }

  public generateCompatibilityBlock(
    demandType: string,
    demandAnalysis: Record<string, unknown>,
  ): CompatibilityBlock {
    const constraints = this.realityConstraints.getConstraintsForDemandType(demandType as any);

    const adherenceCheck = this.realityConstraints.checkAdherence(
      demandAnalysis,
      demandType as any,
    );

    return {
      projectRealityUsed: {
        stack: this.projectReality.stack,
        maturityLevel: this.projectReality.maturityLevel,
        capabilities: this.projectReality.capabilities,
      },
      adherenceToCurrentCode: this.determineAdherenceLevel(adherenceCheck.adherenceScore),
      technicalExtrapolation: this.determineExtrapolationLevel(demandAnalysis),
      constraintsApplied: {
        maturityLevel: this.projectReality.maturityLevel,
        forbiddenTechnologies: constraints.forbiddenTechnologies,
        allowedTechnologies: constraints.allowedTechnologies,
      },
      adherenceScore: adherenceCheck.adherenceScore,
      issuesFound: adherenceCheck.issues,
      generatedAt: new Date().toISOString(),
    };
  }

  private determineAdherenceLevel(score: number): CompatibilityBlock['adherenceToCurrentCode'] {
    if (score >= 80) return 'High';
    if (score >= 50) return 'Medium';
    return 'Low';
  }

  private determineExtrapolationLevel(
    demandAnalysis: Record<string, unknown>,
  ): CompatibilityBlock['technicalExtrapolation'] {
    // Check if demand uses technologies not in the current stack
    const usedTechnologies = (demandAnalysis.technologies as string[]) || [];
    const currentStackTechnologies = [
      ...this.projectReality.stack.frontend,
      ...this.projectReality.stack.backend,
      ...this.projectReality.stack.database,
      ...this.projectReality.stack.infrastructure,
      ...this.projectReality.stack.ai,
    ];

    const newTechnologies = usedTechnologies.filter(
      (tech: string) => !currentStackTechnologies.includes(tech),
    );

    if (newTechnologies.length === 0) {
      return 'None';
    } else if (newTechnologies.length <= 2) {
      return 'Moderate';
    } else {
      return 'High';
    }
  }

  public validateDelivery(delivery: Record<string, unknown>): {
    isValid: boolean;
    missingBlocks: string[];
    compatibilityBlock: CompatibilityBlock | null;
  } {
    const missingBlocks: string[] = [];

    // Check if compatibility block exists
    if (!delivery.compatibilityBlock) {
      missingBlocks.push('Compatibility Block');
    }

    // If we have a compatibility block, validate it
    let compatibilityBlock = null;
    if (delivery.compatibilityBlock) {
      try {
        compatibilityBlock = delivery.compatibilityBlock as CompatibilityBlock;

        // Validate required fields
        const requiredFields = [
          'projectRealityUsed',
          'adherenceToCurrentCode',
          'technicalExtrapolation',
          'constraintsApplied',
          'adherenceScore',
          'issuesFound',
          'generatedAt',
        ];

        for (const field of requiredFields) {
          if (!(compatibilityBlock as unknown as Record<string, unknown>)[field]) {
            missingBlocks.push(`Compatibility Block.${field}`);
          }
        }
      } catch (_error) {
        missingBlocks.push('Valid Compatibility Block');
      }
    }

    return {
      isValid: missingBlocks.length === 0,
      missingBlocks,
      compatibilityBlock,
    };
  }
}
