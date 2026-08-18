import { projectRoot } from '@shared/utils/paths';
import { Demand } from '@shared/schema';
import { ProjectRealityReader, ProjectReality } from './project-reality-reader';
import { RealityConstraints, type FullConstraints } from './reality-constraints';
import { CompatibilityBlockGenerator, type CompatibilityBlock } from './compatibility-block';
import { agentOrchestrator } from './agent-orchestrator';
import type { OrchestrationPlan, DemandClassification } from '../orchestration-contracts';
import { IRealityBasedRefinement } from '../orchestration-contracts';
import { demandClassifier } from './demand-classifier';

interface RealityBasedRefinementResult {
  projectReality: ProjectReality;
  constraints: FullConstraints;
  compatibilityBlock: CompatibilityBlock;
  orchestrationPlan: OrchestrationPlan;
  demandClassification: DemandClassification;
  generatedAt: string;
}

export class RealityBasedRefinement implements IRealityBasedRefinement {
  private projectRealityReader: ProjectRealityReader;

  constructor(root: string = projectRoot) {
    this.projectRealityReader = new ProjectRealityReader(root);
  }

  public async refineDemandWithRealityCheck(
    demandId: number,
  ): Promise<RealityBasedRefinementResult> {
    // Step 1: Read project reality (MANDATORY before any refinement)
    const projectReality = await this.projectRealityReader.readProjectReality();

    // Step 2: Classify the demand
    const demand = await this.getDemand(demandId);
    const demandClassification = await demandClassifier.classifyDemand(demand);

    // Step 3: Get reality constraints for this demand type
    const realityConstraints = new RealityConstraints(projectReality);
    const constraints = realityConstraints.getConstraintsForDemandType(
      demandClassification.category as string,
    );

    // Step 4: Generate compatibility block
    const compatibilityBlockGenerator = new CompatibilityBlockGenerator(projectReality);
    const compatibilityBlock = compatibilityBlockGenerator.generateCompatibilityBlock(
      demandClassification.category,
      this.createDemandAnalysisFromClassification(demandClassification),
    );

    // Step 5: Create orchestration plan with reality constraints
    const orchestrationPlan = await this.createRealityConstrainedOrchestrationPlan(
      demandId,
      demandClassification,
      constraints,
    );

    return {
      projectReality,
      constraints,
      compatibilityBlock,
      orchestrationPlan,
      demandClassification,
      generatedAt: new Date().toISOString(),
    };
  }

  private async getDemand(demandId: number): Promise<Demand> {
    // This would normally come from storage, but we'll mock it for now
    // In a real implementation, you would use the storage service
    return {
      id: demandId,
      title: `Demand ${demandId}`,
      description: `Description for demand ${demandId}`,
      type: 'feature',
      status: 'new',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as Demand;
  }

  private createDemandAnalysisFromClassification(
    classification: DemandClassification,
  ): Record<string, unknown> {
    // Create a mock demand analysis based on the classification
    return {
      technologies: [],
      technicalDepth: classification.criteria.complexity / 20,
      architectureChanges: classification.criteria.complexity > 70 ? 1 : 0,
      newDependencies: classification.criteria.depthRequired > 60 ? 1 : 0,
      scope: classification.criteria.complexity > 60 ? 'moderate' : 'incremental',
    };
  }

  private async createRealityConstrainedOrchestrationPlan(
    demandId: number,
    classification: DemandClassification,
    constraints: FullConstraints,
  ): Promise<OrchestrationPlan> {
    // Get the base orchestration plan
    const basePlan = await agentOrchestrator.createOrchestrationPlan(demandId);

    // Apply reality constraints to the plan
    return {
      ...basePlan,
      notes: this.addRealityConstraintsToNotes(basePlan.notes, constraints),
      classification: {
        ...basePlan.classification,
        realityConstraints: {
          maturityLevel: constraints.maturityLevel,
          forbiddenTechnologies: constraints.forbiddenTechnologies,
          allowedTechnologies: constraints.allowedTechnologies,
          capabilities: Object.entries(constraints.capabilities)
            .filter(([, enabled]) => enabled)
            .map(([name]) => name),
        },
      },
    };
  }

  private addRealityConstraintsToNotes(baseNotes: string, constraints: FullConstraints): string {
    const realityNotes = [
      '📌 REALITY CONSTRAINTS APPLIED:',
      `🔧 Maturity Level: ${constraints.maturityLevel}`,
      `🛠️ Allowed Technologies: ${constraints.allowedTechnologies.join(', ')}`,
      `🚫 Forbidden Technologies: ${constraints.forbiddenTechnologies.join(', ')}`,
      `💡 Capabilities: ${JSON.stringify(constraints.capabilities)}`,
      '✅ All agents must adhere to these constraints',
    ];

    return `${baseNotes}\n\n${realityNotes.join('\n')}`;
  }

  public async validateDeliveryWithRealityCheck(
    delivery: Record<string, unknown>,
    demandType: string,
  ): Promise<{
    isValid: boolean;
    validationReport: string;
  }> {
    // Read current project reality
    const projectReality = await this.projectRealityReader.readProjectReality();

    // Create compatibility block generator
    const compatibilityBlockGenerator = new CompatibilityBlockGenerator(projectReality);

    // Validate the delivery
    const validation = compatibilityBlockGenerator.validateDelivery(delivery);

    if (!validation.isValid) {
      return {
        isValid: false,
        validationReport:
          `❌ Delivery validation failed:\n` +
          `Missing blocks: ${validation.missingBlocks.join(', ')}\n` +
          `Compatibility block: ${validation.compatibilityBlock ? 'Present' : 'Missing'}`,
      };
    }

    // Check adherence to reality constraints
    const realityConstraints = new RealityConstraints(projectReality);
    const adherenceCheck = realityConstraints.checkAdherence(delivery.analysis || {}, demandType);

    if (!adherenceCheck.isAdherent) {
      return {
        isValid: false,
        validationReport:
          `❌ Reality adherence check failed:\n` +
          `Issues: ${adherenceCheck.issues.join('; ')}\n` +
          `Adherence score: ${adherenceCheck.adherenceScore}%`,
      };
    }

    return {
      isValid: true,
      validationReport:
        `✅ Delivery validation passed:\n` +
        `Adherence to current code: ${validation.compatibilityBlock?.adherenceToCurrentCode || 'Unknown'}\n` +
        `Technical extrapolation: ${validation.compatibilityBlock?.technicalExtrapolation || 'Unknown'}\n` +
        `Adherence score: ${adherenceCheck.adherenceScore}%`,
    };
  }

  public async getCurrentProjectReality(): Promise<ProjectReality> {
    return await this.projectRealityReader.readProjectReality();
  }

  public async getConstraintsForDemandType(demandType: string): Promise<FullConstraints> {
    const projectReality = await this.projectRealityReader.readProjectReality();
    const realityConstraints = new RealityConstraints(projectReality);
    return realityConstraints.getConstraintsForDemandType(demandType);
  }
}
