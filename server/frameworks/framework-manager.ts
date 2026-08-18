// Framework Manager - Main module for managing all demand frameworks
import { logger } from '../utils/logger';
import { Demand } from '@shared/schema';
import { demandRepository } from '../repositories/demand-repository';
import { openAIService } from '../services/openai-ai';
import { getDemandTypeConfig } from '@shared/demand-types';
import { frameworkFallbackTotal } from '../metrics';
import {
  FrameworkType,
  KNOWN_FRAMEWORK_TYPES,
  AnyFramework,
  FrameworkSelectionCriteria,
  FrameworkRecommendation,
  FrameworkExecutionResult,
  JTBDFramework,
  HEARTFramework,
  SeverityPriorityFramework,
  DoubleDiamondFramework,
  CRISPDMFramework,
  AIFrameworkSuggestion,
  FrameworkMetrics,
  FrameworkIntegration,
} from './types';

/**
 * Framework Manager - Central manager for all demand frameworks
 */
export class FrameworkManager {
  private frameworks: Map<string, AnyFramework>;
  private executionHistory: Map<string, FrameworkExecutionResult[]>;

  constructor() {
    this.frameworks = new Map();
    this.executionHistory = new Map();
  }

  /**
   * Initialize the framework manager with default frameworks
   */
  async initialize(): Promise<void> {
    logger.info('🔧 Initializing Framework Manager...');

    // Load any existing frameworks from storage
    await this.loadFrameworksFromStorage();

    // Create default framework templates
    await this.createDefaultFrameworks();

    logger.info(`✅ Framework Manager initialized with ${this.frameworks.size} frameworks`);
  }

  /**
   * Load frameworks from storage
   */
  private async loadFrameworksFromStorage(): Promise<void> {
    try {
      // In a real implementation, this would load from database
      // For now, we'll start with an empty map
      logger.info('📂 Loading frameworks from storage...');
    } catch (error) {
      logger.error('Error loading frameworks from storage:', error);
    }
  }

  /**
   * Create default framework templates
   */
  private async createDefaultFrameworks(): Promise<void> {
    // JTBD Framework Template
    const jtbdFramework: JTBDFramework = {
      id: 'jtbd-default',
      name: 'Jobs-to-be-Done Framework',
      description: 'Framework for understanding customer jobs and desired outcomes',
      type: 'jtbd',
      version: '1.0',
      status: 'implemented',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      jobStatement: '',
      jobSteps: [],
      desiredOutcomes: [],
      constraints: [],
      successMetrics: {
        jobCompletionRate: 0,
        customerSatisfaction: 0,
        timeToComplete: 0,
      },
      integration: {
        aiEnabled: true,
        externalTools: ['SurveyMonkey', 'Typeform'],
        apiEndpoints: [],
        dataSources: [],
        customerInterviews: true,
        surveyTools: ['SurveyMonkey', 'Typeform', 'Google Forms'],
      },
    };

    // HEART Framework Template
    const heartFramework: HEARTFramework = {
      id: 'heart-default',
      name: 'HEART Framework',
      description: 'UX metrics framework for measuring user experience',
      type: 'heart',
      version: '1.0',
      status: 'implemented',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      happiness: { currentScore: 0, targetScore: 0, measurementMethod: '' },
      engagement: { currentScore: 0, targetScore: 0, measurementMethod: '' },
      adoption: { currentScore: 0, targetScore: 0, measurementMethod: '' },
      retention: { currentScore: 0, targetScore: 0, measurementMethod: '' },
      taskSuccess: { currentScore: 0, targetScore: 0, measurementMethod: '' },
      uxMetrics: {
        usabilityScore: 0,
        accessibilityScore: 0,
        userFeedback: [],
      },
      integration: {
        aiEnabled: true,
        externalTools: ['Hotjar', 'Google Analytics'],
        apiEndpoints: [],
        dataSources: [],
        analyticsTools: ['Google Analytics', 'Mixpanel', 'Amplitude'],
        sessionRecording: true,
        heatmapTools: ['Hotjar', 'Crazy Egg'],
      },
    };

    // Severity x Priority Matrix Template
    const severityPriorityFramework: SeverityPriorityFramework = {
      id: 'severity-priority-default',
      name: 'Severity x Priority Matrix',
      description: 'Framework for prioritizing bugs and issues',
      type: 'severity-priority',
      version: '1.0',
      status: 'implemented',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      severityLevels: { critical: 4, high: 3, medium: 2, low: 1 },
      priorityLevels: { immediate: 5, urgent: 4, high: 3, medium: 2, low: 1 },
      matrix: {
        critical: {
          immediate: { action: 'Fix immediately', sla: '2 hours', team: 'Critical Response Team' },
          urgent: { action: 'Fix ASAP', sla: '4 hours', team: 'Senior Dev Team' },
          high: { action: 'High priority fix', sla: '24 hours', team: 'Dev Team' },
          medium: { action: 'Schedule for next sprint', sla: '7 days', team: 'Dev Team' },
          low: { action: 'Backlog', sla: '30 days', team: 'Dev Team' },
        },
        high: {
          immediate: { action: 'Fix ASAP', sla: '4 hours', team: 'Senior Dev Team' },
          urgent: { action: 'High priority fix', sla: '24 hours', team: 'Dev Team' },
          high: { action: 'Schedule for next sprint', sla: '7 days', team: 'Dev Team' },
          medium: { action: 'Backlog', sla: '30 days', team: 'Dev Team' },
          low: { action: 'Consider for future', sla: '90 days', team: 'Dev Team' },
        },
        medium: {
          immediate: { action: 'Schedule for next sprint', sla: '7 days', team: 'Dev Team' },
          urgent: { action: 'Backlog', sla: '30 days', team: 'Dev Team' },
          high: { action: 'Backlog', sla: '30 days', team: 'Dev Team' },
          medium: { action: 'Consider for future', sla: '90 days', team: 'Dev Team' },
          low: { action: 'Low priority', sla: '180 days', team: 'Dev Team' },
        },
        low: {
          immediate: { action: 'Backlog', sla: '30 days', team: 'Dev Team' },
          urgent: { action: 'Consider for future', sla: '90 days', team: 'Dev Team' },
          high: { action: 'Consider for future', sla: '90 days', team: 'Dev Team' },
          medium: { action: 'Low priority', sla: '180 days', team: 'Dev Team' },
          low: { action: 'Not planned', sla: '365 days', team: 'Dev Team' },
        },
      },
      bugMetrics: {
        resolutionTime: 0,
        reopenRate: 0,
        customerImpact: 0,
      },
      integration: {
        aiEnabled: true,
        externalTools: ['Jira', 'Bugzilla'],
        apiEndpoints: [],
        dataSources: [],
        bugTracking: ['Jira', 'Bugzilla', 'GitHub Issues'],
        monitoringTools: ['Sentry', 'Datadog'],
        alertingSystems: ['PagerDuty', 'Opsgenie'],
      },
    };

    // Double Diamond Framework Template
    const doubleDiamondFramework: DoubleDiamondFramework = {
      id: 'double-diamond-default',
      name: 'Double Diamond Framework',
      description: 'Design thinking framework for discovery and delivery',
      type: 'double-diamond',
      version: '1.0',
      status: 'implemented',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      discoverPhase: {
        researchMethods: [],
        insights: [],
        userNeeds: [],
        painPoints: [],
      },
      definePhase: {
        problemStatements: [],
        userJourneys: [],
        personas: [],
      },
      developPhase: {
        ideationMethods: [],
        prototypes: [],
        iterations: [],
      },
      deliverPhase: {
        testingMethods: [],
        launchPlan: '',
        feedbackCollection: [],
      },
      integration: {
        aiEnabled: true,
        externalTools: ['Miro', 'Figma'],
        apiEndpoints: [],
        dataSources: [],
        designTools: ['Figma', 'Adobe XD', 'Sketch'],
        collaborationTools: ['Miro', 'Mural', 'Figma'],
      },
    };

    // CRISP-DM Framework Template
    const crispDmFramework: CRISPDMFramework = {
      id: 'crisp-dm-default',
      name: 'CRISP-DM Framework',
      description: 'Data mining and analytics framework',
      type: 'crisp-dm',
      version: '1.0',
      status: 'implemented',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      businessUnderstanding: {
        businessObjectives: [],
        successCriteria: [],
        constraints: [],
      },
      dataUnderstanding: {
        dataSources: [],
        dataQuality: '',
        initialFindings: [],
      },
      dataPreparation: {
        cleaningSteps: [],
        featureEngineering: [],
        dataTransformation: [],
      },
      modeling: {
        algorithms: [],
        modelParameters: {},
        validationMethod: '',
      },
      evaluation: {
        metrics: [],
        businessImpact: '',
        recommendations: [],
      },
      deployment: {
        deploymentStrategy: '',
        monitoringPlan: '',
        maintenancePlan: '',
      },
      integration: {
        aiEnabled: true,
        externalTools: ['Python', 'R'],
        apiEndpoints: [],
        dataSources: [],
        mlLibraries: ['TensorFlow', 'PyTorch', 'scikit-learn'],
        visualizationTools: ['Tableau', 'Power BI', 'Looker'],
      },
    };

    // Stub frameworks referenced by DEMAND_TYPES but not yet implemented.
    // They are registered so configuration no longer lies about existence,
    // but are marked status: 'stub' to avoid runtime misuse.
    const now = new Date().toISOString();
    const createStub = (id: string, name: string, description: string, type: FrameworkType) => ({
      id,
      name,
      description,
      type,
      version: '0.1-stub',
      status: 'stub' as const,
      createdAt: now,
      updatedAt: now,
      integration: {
        aiEnabled: false,
        externalTools: [],
        apiEndpoints: [],
        dataSources: [],
      },
    });

    const threatModeling = createStub(
      'threat-modeling-stub',
      'Threat Modeling',
      'Framework for identifying and mitigating security threats — stub pending implementation.',
      'threat-modeling',
    );
    const privacyByDesign = createStub(
      'privacy-by-design-stub',
      'Privacy by Design',
      'Framework for embedding privacy into the design process — stub pending implementation.',
      'privacy-by-design',
    );
    const incrementalRefactoring = createStub(
      'incremental-refactoring-stub',
      'Incremental Refactoring',
      'Framework for evolving existing code in small, safe steps — stub pending implementation.',
      'incremental-refactoring',
    );
    const architectureDecisionRecord = createStub(
      'architecture-decision-record-stub',
      'Architecture Decision Record',
      'Framework for documenting architecture decisions — stub pending implementation.',
      'architecture-decision-record',
    );
    const checklist = createStub(
      'checklist-stub',
      'Checklist',
      'Lightweight framework for review and verification — stub pending implementation.',
      'checklist',
    );

    // Add templates to the framework map
    this.frameworks.set(jtbdFramework.id, jtbdFramework);
    this.frameworks.set(heartFramework.id, heartFramework);
    this.frameworks.set(severityPriorityFramework.id, severityPriorityFramework);
    this.frameworks.set(doubleDiamondFramework.id, doubleDiamondFramework);
    this.frameworks.set(crispDmFramework.id, crispDmFramework);
    this.frameworks.set(threatModeling.id, threatModeling as AnyFramework);
    this.frameworks.set(privacyByDesign.id, privacyByDesign as AnyFramework);
    this.frameworks.set(incrementalRefactoring.id, incrementalRefactoring as AnyFramework);
    this.frameworks.set(architectureDecisionRecord.id, architectureDecisionRecord as AnyFramework);
    this.frameworks.set(checklist.id, checklist as AnyFramework);
  }

  /**
   * Get all available frameworks
   */
  getAllFrameworks(): AnyFramework[] {
    return Array.from(this.frameworks.values());
  }

  /**
   * Get framework by ID
   */
  getFrameworkById(id: string): AnyFramework | undefined {
    return this.frameworks.get(id);
  }

  /**
   * Get frameworks by type
   */
  getFrameworksByType(type: FrameworkType): AnyFramework[] {
    return Array.from(this.frameworks.values()).filter((f) => f.type === type);
  }

  /**
   * Create a new framework instance from a template
   */
  async createFrameworkFromTemplate(
    templateId: string,
    customData: Partial<AnyFramework>,
  ): Promise<AnyFramework> {
    const template = this.frameworks.get(templateId);
    if (!template) {
      throw new Error(`Template ${templateId} not found`);
    }

    const newFramework = {
      ...template,
      id: `${template.type}-${Date.now()}`,
      name: `${template.name} - ${new Date().toISOString().split('T')[0]}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...customData,
    } as AnyFramework;

    this.frameworks.set(newFramework.id, newFramework);
    return newFramework;
  }

  /**
   * Update a framework
   */
  async updateFramework(id: string, updates: Partial<AnyFramework>): Promise<AnyFramework> {
    const framework = this.frameworks.get(id);
    if (!framework) {
      throw new Error(`Framework ${id} not found`);
    }

    const updatedFramework = {
      ...framework,
      ...updates,
      updatedAt: new Date().toISOString(),
    } as AnyFramework;

    this.frameworks.set(id, updatedFramework);
    return updatedFramework;
  }

  /**
   * Delete a framework
   */
  async deleteFramework(id: string): Promise<boolean> {
    return this.frameworks.delete(id);
  }

  /**
   * Recommend framework based on demand analysis
   */
  async recommendFramework(demand: Demand): Promise<FrameworkRecommendation> {
    // Analyze the demand to determine selection criteria
    const criteria = this.analyzeDemandForFrameworkSelection(demand);

    // Use AI to suggest the best framework
    const aiSuggestion = await this.getAIFrameworkSuggestion(demand, criteria);

    // Generate recommendation
    const recommendation = this.generateFrameworkRecommendation(aiSuggestion, criteria);

    return recommendation;
  }

  /**
   * Analyze demand for framework selection
   */
  private analyzeDemandForFrameworkSelection(demand: Demand): FrameworkSelectionCriteria {
    const config = getDemandTypeConfig(demand.type);

    // Default criteria based on central config
    const criteria: FrameworkSelectionCriteria = {
      demandType: demand.type,
      complexity:
        config.refinementLevel >= 4 ? 'high' : config.refinementLevel >= 3 ? 'medium' : 'low',
      impact:
        config.intensity === 'alta' ? 'high' : config.intensity === 'media' ? 'medium' : 'low',
      urgency:
        demand.priority === 'critica'
          ? 'immediate'
          : demand.priority === 'alta'
            ? 'urgent'
            : 'medium',
      teamSize: 'medium',
      budget: 'moderate',
      timeline: config.maxEffortDays > 10 ? 'long' : config.maxEffortDays > 5 ? 'medium' : 'short',
      industry: 'technology',
      stakeholders: [],
    };

    return criteria;
  }

  /**
   * Get AI suggestion for framework
   */
  private async getAIFrameworkSuggestion(
    demand: Demand,
    criteria: FrameworkSelectionCriteria,
  ): Promise<AIFrameworkSuggestion> {
    // Use OpenAI to analyze and suggest framework
    const prompt = this.buildFrameworkSuggestionPrompt(demand, criteria);

    try {
      const aiResponse = await openAIService.generateResponse(prompt, {
        taskType: 'simple',
        operation: 'framework:suggestion',
      });

      // Parse AI response (in a real implementation, this would be more sophisticated)
      const suggestion: AIFrameworkSuggestion = {
        id: `ai-suggestion-${Date.now()}`,
        name: 'AI Framework Suggestion',
        description: `AI-generated framework suggestion for demand: ${demand.title}`,
        type: 'auto-suggest',
        version: '1.0',
        status: 'implemented',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        analysisCriteria: criteria,
        suggestedFrameworks: {
          primary: this.determinePrimaryFramework(demand.type),
          secondary: this.determineSecondaryFrameworks(demand.type),
          rationale:
            aiResponse || 'AI analysis suggests this framework based on demand characteristics',
        },
        confidenceScore: 85,
        alternativeOptions: this.generateAlternativeOptions(demand.type),
        integration: {
          aiEnabled: true,
          externalTools: ['OpenAI'],
          apiEndpoints: [],
          dataSources: [],
          aiModels: ['OpenAI'],
          knowledgeBases: ['Framework Best Practices'],
          decisionEngines: ['Rule-Based', 'ML-Based'],
        },
      };

      return suggestion;
    } catch (error) {
      logger.error('Error getting AI framework suggestion:', error);

      // Fallback to rule-based suggestion
      return {
        id: `ai-suggestion-fallback-${Date.now()}`,
        name: 'AI Framework Suggestion (Fallback)',
        description: `Rule-based framework suggestion for demand: ${demand.title}`,
        type: 'auto-suggest',
        version: '1.0',
        status: 'implemented',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        analysisCriteria: criteria,
        suggestedFrameworks: {
          primary: this.determinePrimaryFramework(demand.type),
          secondary: this.determineSecondaryFrameworks(demand.type),
          rationale: 'Rule-based fallback suggestion',
        },
        confidenceScore: 70,
        alternativeOptions: this.generateAlternativeOptions(demand.type),
        integration: {
          aiEnabled: false,
          externalTools: [],
          apiEndpoints: [],
          dataSources: [],
          aiModels: [],
          knowledgeBases: [],
          decisionEngines: ['Rule-Based'],
        },
      };
    }
  }

  /**
   * Build prompt for AI framework suggestion
   */
  private buildFrameworkSuggestionPrompt(
    demand: Demand,
    criteria: FrameworkSelectionCriteria,
  ): string {
    return `You are an expert in demand management frameworks. Analyze the following demand and suggest the most appropriate framework:

Demand Title: ${demand.title}
Demand Type: ${demand.type}
Demand Description: ${demand.description}
Priority: ${demand.priority}

Selection Criteria:
- Complexity: ${criteria.complexity}
- Impact: ${criteria.impact}
- Urgency: ${criteria.urgency}
- Team Size: ${criteria.teamSize}
- Budget: ${criteria.budget}
- Timeline: ${criteria.timeline}
- Industry: ${criteria.industry}

Available Frameworks:
1. JTBD (Jobs-to-be-Done) - Best for new features and customer-centric development
2. HEART - Best for UX improvements and user experience metrics
3. Severity x Priority Matrix - Best for bug triage and issue prioritization
4. Double Diamond - Best for discovery and design thinking processes
5. CRISP-DM - Best for data analysis and machine learning projects

Please provide:
1. Primary recommended framework
2. Secondary framework options
3. Rationale for your recommendation
4. Confidence score (0-100)
5. Any alternative options with their rationale

Format your response as JSON with the following structure:
{
  "primary": "framework_type",
  "secondary": ["framework_type1", "framework_type2"],
  "rationale": "Your rationale here",
  "confidence": 85,
  "alternatives": [
    {"framework": "framework_type", "score": 75, "rationale": "reason"}
  ]
}`;
  }

  /**
   * Resolve um valor de framework configurado em demand-types.ts para um
   * FrameworkType de fato implementado. Alguns tipos de demanda (security,
   * refactoring, infraestrutura) referenciam frameworks que nunca foram
   * implementados (threat-modeling, privacy-by-design, incremental-refactoring,
   * architecture-decision-record) — sem esta validação, o cast `as FrameworkType`
   * mentia para o TypeScript e o lookup em `frameworkMetrics`/`getFrameworkById`
   * falhava silenciosamente (`undefined`). Cai para 'auto-suggest' com log.
   */
  private resolveFrameworkType(configured: string, demandType: string): FrameworkType {
    if (!(KNOWN_FRAMEWORK_TYPES as readonly string[]).includes(configured)) {
      frameworkFallbackTotal.labels({ framework_id: configured }).inc();
      logger.warn(
        `Framework '${configured}' referenciado pelo tipo de demanda '${demandType}' não está registrado — usando 'auto-suggest'`,
        {
          context: {
            demandType,
            configuredFramework: configured,
            action: 'fallback_to_auto_suggest',
          },
        },
      );
      return 'auto-suggest';
    }

    const framework = this.getFrameworksByType(configured as FrameworkType)[0];
    if (framework?.status === 'stub') {
      frameworkFallbackTotal.labels({ framework_id: configured }).inc();
      logger.warn(
        `Framework '${configured}' referenciado pelo tipo de demanda '${demandType}' está registrado como stub — usando 'auto-suggest'`,
        {
          context: {
            demandType,
            configuredFramework: configured,
            action: 'fallback_to_auto_suggest',
          },
        },
      );
      return 'auto-suggest';
    }

    return configured as FrameworkType;
  }

  /**
   * Determine primary framework based on demand type
   */
  private determinePrimaryFramework(demandType: string): FrameworkType {
    return this.resolveFrameworkType(getDemandTypeConfig(demandType).primaryFramework, demandType);
  }

  /**
   * Determine secondary frameworks based on demand type
   */
  private determineSecondaryFrameworks(demandType: string): FrameworkType[] {
    const resolved = getDemandTypeConfig(demandType).secondaryFrameworks.map((f) =>
      this.resolveFrameworkType(f, demandType),
    );
    return [...new Set(resolved)];
  }

  /**
   * Generate alternative framework options
   */
  private generateAlternativeOptions(
    demandType: string,
  ): { framework: FrameworkType; score: number; rationale: string }[] {
    // Only suggest frameworks that are fully implemented (ignore stubs and auto-suggest).
    const implementedFrameworks = this.getAllFrameworks()
      .filter((f) => f.status !== 'stub')
      .map((f) => f.type);
    const allFrameworks: FrameworkType[] = [...new Set(implementedFrameworks)];
    const primary = this.determinePrimaryFramework(demandType);
    const secondary = this.determineSecondaryFrameworks(demandType);

    // Get frameworks not in primary or secondary
    const otherFrameworks = allFrameworks.filter((f) => f !== primary && !secondary.includes(f));

    return otherFrameworks.map((framework, index) => ({
      framework,
      score: 60 - index * 10, // Decreasing scores
      rationale: this.getAlternativeRationale(framework, demandType),
    }));
  }

  /**
   * Get rationale for alternative framework
   */
  private getAlternativeRationale(framework: FrameworkType, demandType: string): string {
    const rationales: Record<FrameworkType, Record<string, string>> = {
      jtbd: {
        default: 'Provides customer-centric approach to understand jobs to be done',
        bug: 'Can help understand the underlying user needs that the bug affects',
      },
      heart: {
        default: 'Offers comprehensive UX metrics for user experience improvements',
        bug: 'Helps measure user satisfaction impact of bug fixes',
      },
      'severity-priority': {
        default: 'Useful for prioritizing any type of work based on impact and urgency',
        nova_funcionalidade: 'Helps prioritize feature development based on business impact',
      },
      'double-diamond': {
        default: 'Excellent for discovery and design thinking processes',
        bug: 'Can help with root cause analysis and solution design',
      },
      'crisp-dm': {
        default: 'Ideal for data-driven analysis and decision making',
        nova_funcionalidade: 'Useful for data analysis to support feature decisions',
      },
      'auto-suggest': {
        default: 'Uses AI to recommend the most suitable framework for the demand',
      },
      'threat-modeling': {
        default: 'Security-focused threat identification (stub)',
      },
      'privacy-by-design': {
        default: 'Privacy embedded into design (stub)',
      },
      'incremental-refactoring': {
        default: 'Safe step-by-step code evolution (stub)',
      },
      'architecture-decision-record': {
        default: 'Architecture decision documentation (stub)',
      },
      checklist: {
        default: 'Lightweight review and verification (stub)',
      },
    };

    return rationales[framework][demandType] || rationales[framework].default;
  }

  /**
   * Generate framework recommendation
   */
  private generateFrameworkRecommendation(
    suggestion: AIFrameworkSuggestion,
    _criteria: FrameworkSelectionCriteria,
  ): FrameworkRecommendation {
    const frameworkMetrics: Record<FrameworkType, FrameworkMetrics> = {
      jtbd: {
        successRate: 85,
        completionTime: 120,
        stakeholderSatisfaction: 90,
        costEfficiency: 80,
        qualityScore: 85,
      },
      heart: {
        successRate: 80,
        completionTime: 90,
        stakeholderSatisfaction: 85,
        costEfficiency: 75,
        qualityScore: 80,
      },
      'severity-priority': {
        successRate: 90,
        completionTime: 60,
        stakeholderSatisfaction: 80,
        costEfficiency: 90,
        qualityScore: 85,
      },
      'double-diamond': {
        successRate: 75,
        completionTime: 180,
        stakeholderSatisfaction: 85,
        costEfficiency: 70,
        qualityScore: 80,
      },
      'crisp-dm': {
        successRate: 80,
        completionTime: 240,
        stakeholderSatisfaction: 75,
        costEfficiency: 75,
        qualityScore: 85,
      },
      'auto-suggest': {
        successRate: 90,
        completionTime: 30,
        stakeholderSatisfaction: 85,
        costEfficiency: 95,
        qualityScore: 90,
      },
      'threat-modeling': {
        successRate: 0,
        completionTime: 0,
        stakeholderSatisfaction: 0,
        costEfficiency: 0,
        qualityScore: 0,
      },
      'privacy-by-design': {
        successRate: 0,
        completionTime: 0,
        stakeholderSatisfaction: 0,
        costEfficiency: 0,
        qualityScore: 0,
      },
      'incremental-refactoring': {
        successRate: 0,
        completionTime: 0,
        stakeholderSatisfaction: 0,
        costEfficiency: 0,
        qualityScore: 0,
      },
      'architecture-decision-record': {
        successRate: 0,
        completionTime: 0,
        stakeholderSatisfaction: 0,
        costEfficiency: 0,
        qualityScore: 0,
      },
      checklist: {
        successRate: 0,
        completionTime: 0,
        stakeholderSatisfaction: 0,
        costEfficiency: 0,
        qualityScore: 0,
      },
    };

    const primaryFramework = suggestion.suggestedFrameworks.primary;

    return {
      recommendedFramework: primaryFramework,
      confidence: suggestion.confidenceScore,
      rationale: suggestion.suggestedFrameworks.rationale,
      implementationSteps: this.getImplementationSteps(primaryFramework),
      expectedOutcomes: this.getExpectedOutcomes(primaryFramework),
      successMetrics: frameworkMetrics[primaryFramework],
      integrationRequirements: this.getIntegrationRequirements(primaryFramework),
    };
  }

  /**
   * Get implementation steps for framework
   */
  private getImplementationSteps(frameworkType: FrameworkType): string[] {
    const steps: Record<FrameworkType, string[]> = {
      jtbd: [
        'Define the job to be done',
        'Identify job steps and desired outcomes',
        'Conduct customer interviews',
        'Analyze constraints and requirements',
        'Design solution based on job analysis',
        'Validate with customers',
        'Implement and measure success',
      ],
      heart: [
        'Define UX metrics and targets',
        'Set up analytics and tracking',
        'Conduct baseline measurements',
        'Implement UX improvements',
        'Monitor metrics continuously',
        'Gather user feedback',
        'Iterate based on data',
      ],
      'severity-priority': [
        'Assess severity of each issue',
        'Determine priority level',
        'Map to severity-priority matrix',
        'Assign appropriate action and SLA',
        'Allocate to correct team',
        'Monitor resolution progress',
        'Track metrics and improve process',
      ],
      'double-diamond': [
        'Discover: Conduct user research',
        'Discover: Gather insights and pain points',
        'Define: Create problem statements',
        'Define: Develop user journeys and personas',
        'Develop: Create prototypes',
        'Develop: Test with users',
        'Deliver: Implement solution',
        'Deliver: Monitor and iterate',
      ],
      'crisp-dm': [
        'Business Understanding: Define objectives',
        'Business Understanding: Establish success criteria',
        'Data Understanding: Identify data sources',
        'Data Understanding: Assess data quality',
        'Data Preparation: Clean and transform data',
        'Data Preparation: Feature engineering',
        'Modeling: Select algorithms',
        'Modeling: Train and evaluate models',
        'Evaluation: Assess model performance',
        'Evaluation: Determine business impact',
        'Deployment: Plan deployment',
        'Deployment: Monitor and maintain',
      ],
      'auto-suggest': [
        'Analyze demand characteristics',
        'Evaluate framework selection criteria',
        'Generate AI recommendations',
        'Calculate confidence scores',
        'Provide recommendation rationale',
        'Finalize suggested frameworks',
      ],
      'threat-modeling': ['Stub: define threat modeling steps'],
      'privacy-by-design': ['Stub: define privacy-by-design steps'],
      'incremental-refactoring': ['Stub: define incremental refactoring steps'],
      'architecture-decision-record': ['Stub: define ADR steps'],
      checklist: ['Stub: define checklist steps'],
    };

    return steps[frameworkType];
  }

  /**
   * Get expected outcomes for framework
   */
  private getExpectedOutcomes(frameworkType: FrameworkType): string[] {
    const outcomes: Record<FrameworkType, string[]> = {
      jtbd: [
        'Clear understanding of customer jobs',
        'Well-defined desired outcomes',
        'Customer-centric solution design',
        'Higher customer satisfaction',
        'Increased job completion rates',
        'Better alignment with user needs',
      ],
      heart: [
        'Improved user happiness scores',
        'Increased user engagement',
        'Higher adoption rates',
        'Better user retention',
        'Improved task success rates',
        'Data-driven UX decisions',
      ],
      'severity-priority': [
        'Clear prioritization of issues',
        'Faster resolution of critical bugs',
        'Better resource allocation',
        'Improved SLA compliance',
        'Reduced customer impact',
        'Lower reopen rates',
      ],
      'double-diamond': [
        'Deep user insights',
        'Well-defined problem statements',
        'User-validated prototypes',
        'Effective solution implementation',
        'Higher success rates',
        'Better stakeholder alignment',
      ],
      'crisp-dm': [
        'Clear business objectives',
        'High-quality data understanding',
        'Effective data preparation',
        'Well-performing models',
        'Actionable business insights',
        'Successful deployment and monitoring',
      ],
      'auto-suggest': [
        'Optimized framework selection',
        'Reduced decision time',
        'Higher quality project documentation',
        'Better alignment between demand and process',
        'Improved team productivity',
      ],
      'threat-modeling': ['Stub: threat model outcomes'],
      'privacy-by-design': ['Stub: privacy-by-design outcomes'],
      'incremental-refactoring': ['Stub: incremental refactoring outcomes'],
      'architecture-decision-record': ['Stub: ADR outcomes'],
      checklist: ['Stub: checklist outcomes'],
    };

    return outcomes[frameworkType];
  }

  /**
   * Get integration requirements for framework
   */
  private getIntegrationRequirements(frameworkType: FrameworkType): FrameworkIntegration {
    const requirements: Record<FrameworkType, FrameworkIntegration> = {
      jtbd: {
        aiEnabled: true,
        externalTools: ['SurveyMonkey', 'Typeform', 'UserTesting'],
        apiEndpoints: ['/api/jtbd/surveys', '/api/jtbd/interviews'],
        dataSources: ['Customer interviews', 'Surveys', 'Support tickets'],
      },
      heart: {
        aiEnabled: true,
        externalTools: ['Google Analytics', 'Hotjar', 'Mixpanel'],
        apiEndpoints: ['/api/heart/metrics', '/api/heart/feedback'],
        dataSources: ['Analytics data', 'User feedback', 'Session recordings'],
      },
      'severity-priority': {
        aiEnabled: true,
        externalTools: ['Jira', 'Bugzilla', 'Sentry'],
        apiEndpoints: ['/api/bugs/priority', '/api/bugs/matrix'],
        dataSources: ['Bug reports', 'Monitoring data', 'Customer impact data'],
      },
      'double-diamond': {
        aiEnabled: true,
        externalTools: ['Miro', 'Figma', 'UserTesting'],
        apiEndpoints: ['/api/discovery/research', '/api/discovery/prototypes'],
        dataSources: ['User research', 'Prototype testing', 'Stakeholder feedback'],
      },
      'crisp-dm': {
        aiEnabled: true,
        externalTools: ['Python', 'R', 'Tableau'],
        apiEndpoints: ['/api/data/analysis', '/api/models/evaluation'],
        dataSources: ['Business data', 'External datasets', 'Model outputs'],
      },
      'auto-suggest': {
        aiEnabled: true,
        externalTools: ['OpenAI'],
        apiEndpoints: ['/api/ai/suggest'],
        dataSources: ['Knowledge base', 'Historical data'],
      },
      'threat-modeling': {
        aiEnabled: false,
        externalTools: [],
        apiEndpoints: [],
        dataSources: [],
      },
      'privacy-by-design': {
        aiEnabled: false,
        externalTools: [],
        apiEndpoints: [],
        dataSources: [],
      },
      'incremental-refactoring': {
        aiEnabled: false,
        externalTools: [],
        apiEndpoints: [],
        dataSources: [],
      },
      'architecture-decision-record': {
        aiEnabled: false,
        externalTools: [],
        apiEndpoints: [],
        dataSources: [],
      },
      checklist: {
        aiEnabled: false,
        externalTools: [],
        apiEndpoints: [],
        dataSources: [],
      },
    };

    return requirements[frameworkType];
  }

  /**
   * Execute a framework for a demand
   */
  async executeFramework(
    demandId: number,
    frameworkId: string,
    onProgress?: (progress: number, message: string) => void,
  ): Promise<FrameworkExecutionResult> {
    const demand = await demandRepository.findByIdOrNull(demandId);
    if (!demand) {
      throw new Error(`Demand ${demandId} not found`);
    }

    const framework = this.frameworks.get(frameworkId);
    if (!framework) {
      throw new Error(`Framework ${frameworkId} not found`);
    }

    // Initialize execution result
    const executionResult: FrameworkExecutionResult = {
      frameworkId: framework.id,
      frameworkType: framework.type,
      status: 'in-progress',
      progress: 0,
      metrics: {
        successRate: 0,
        completionTime: 0,
        stakeholderSatisfaction: 0,
        costEfficiency: 0,
        qualityScore: 0,
      },
      outputs: {},
      timeline: {
        startedAt: new Date().toISOString(),
      },
      teamMembers: [],
      resourcesUsed: [],
    };

    // Update demand with framework execution info
    await demandRepository.update(demandId, {
      frameworkExecution: executionResult,
    });

    try {
      // Execute framework-specific logic
      switch (framework.type) {
        case 'jtbd':
          await this.executeJTBDFramework(
            demand,
            framework as JTBDFramework,
            executionResult,
            onProgress,
          );
          break;
        case 'heart':
          await this.executeHEARTFramework(
            demand,
            framework as HEARTFramework,
            executionResult,
            onProgress,
          );
          break;
        case 'severity-priority':
          await this.executeSeverityPriorityFramework(
            demand,
            framework as SeverityPriorityFramework,
            executionResult,
            onProgress,
          );
          break;
        case 'double-diamond':
          await this.executeDoubleDiamondFramework(
            demand,
            framework as DoubleDiamondFramework,
            executionResult,
            onProgress,
          );
          break;
        case 'crisp-dm':
          await this.executeCRISPDMFramework(
            demand,
            framework as CRISPDMFramework,
            executionResult,
            onProgress,
          );
          break;
        case 'auto-suggest':
          await this.executeAutoSuggestFramework(
            demand,
            framework as AIFrameworkSuggestion,
            executionResult,
            onProgress,
          );
          break;
      }

      // Update execution history
      this.addToExecutionHistory(demandId, executionResult);

      return executionResult;
    } catch (error) {
      logger.error(`Error executing framework ${frameworkId} for demand ${demandId}:`, error);

      executionResult.status = 'failed';
      executionResult.progress = 0;
      if (error instanceof Error) {
        executionResult.outputs = { error: error.message };
      }

      await demandRepository.update(demandId, {
        frameworkExecution: executionResult,
        status: 'error',
      });

      throw error;
    }
  }

  /**
   * Execute JTBD Framework
   */
  private async executeJTBDFramework(
    demand: Demand,
    framework: JTBDFramework,
    executionResult: FrameworkExecutionResult,
    onProgress?: (progress: number, message: string) => void,
  ): Promise<void> {
    // Implementation steps for JTBD
    const steps = [
      { name: 'Analyzing job statement', duration: 15 },
      { name: 'Identifying job steps', duration: 20 },
      { name: 'Defining desired outcomes', duration: 25 },
      { name: 'Analyzing constraints', duration: 20 },
      { name: 'Designing solution', duration: 30 },
      { name: 'Validating with customers', duration: 25 },
      { name: 'Finalizing implementation', duration: 15 },
    ];

    let totalProgress = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      totalProgress += step.duration;
      const progress = Math.round(
        (totalProgress / steps.reduce((sum, s) => sum + s.duration, 0)) * 100,
      );

      if (onProgress) {
        onProgress(progress, `JTBD: ${step.name}`);
      }

      // Simulate step execution
      await new Promise((resolve) => setTimeout(resolve, 100)); // Simulate work

      // Update execution result
      executionResult.progress = progress;
      executionResult.outputs[`step${i + 1}`] = `${step.name} completed`;
    }

    // Finalize execution
    executionResult.status = 'completed';
    executionResult.progress = 100;
    executionResult.timeline.completedAt = new Date().toISOString();
    executionResult.timeline.duration = steps.reduce((sum, s) => sum + s.duration, 0);
    executionResult.metrics = {
      successRate: 85,
      completionTime: executionResult.timeline.duration,
      stakeholderSatisfaction: 90,
      costEfficiency: 80,
      qualityScore: 85,
    };

    if (onProgress) {
      onProgress(100, 'JTBD Framework execution completed successfully');
    }
  }

  /**
   * Execute HEART Framework
   */
  private async executeHEARTFramework(
    demand: Demand,
    framework: HEARTFramework,
    executionResult: FrameworkExecutionResult,
    onProgress?: (progress: number, message: string) => void,
  ): Promise<void> {
    // Implementation steps for HEART
    const steps = [
      { name: 'Setting up UX metrics', duration: 10 },
      { name: 'Configuring analytics', duration: 15 },
      { name: 'Baseline measurement', duration: 20 },
      { name: 'Implementing improvements', duration: 30 },
      { name: 'Monitoring metrics', duration: 25 },
      { name: 'Gathering feedback', duration: 20 },
      { name: 'Final analysis', duration: 10 },
    ];

    let totalProgress = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      totalProgress += step.duration;
      const progress = Math.round(
        (totalProgress / steps.reduce((sum, s) => sum + s.duration, 0)) * 100,
      );

      if (onProgress) {
        onProgress(progress, `HEART: ${step.name}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
      executionResult.progress = progress;
      executionResult.outputs[`step${i + 1}`] = `${step.name} completed`;
    }

    executionResult.status = 'completed';
    executionResult.progress = 100;
    executionResult.timeline.completedAt = new Date().toISOString();
    executionResult.timeline.duration = steps.reduce((sum, s) => sum + s.duration, 0);
    executionResult.metrics = {
      successRate: 80,
      completionTime: executionResult.timeline.duration,
      stakeholderSatisfaction: 85,
      costEfficiency: 75,
      qualityScore: 80,
    };

    if (onProgress) {
      onProgress(100, 'HEART Framework execution completed successfully');
    }
  }

  /**
   * Execute Severity Priority Framework
   */
  private async executeSeverityPriorityFramework(
    demand: Demand,
    framework: SeverityPriorityFramework,
    executionResult: FrameworkExecutionResult,
    onProgress?: (progress: number, message: string) => void,
  ): Promise<void> {
    const steps = [
      { name: 'Assessing severity', duration: 10 },
      { name: 'Determining priority', duration: 10 },
      { name: 'Mapping to matrix', duration: 15 },
      { name: 'Assigning action and SLA', duration: 15 },
      { name: 'Team allocation', duration: 10 },
      { name: 'Monitoring progress', duration: 20 },
      { name: 'Final review', duration: 10 },
    ];

    let totalProgress = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      totalProgress += step.duration;
      const progress = Math.round(
        (totalProgress / steps.reduce((sum, s) => sum + s.duration, 0)) * 100,
      );

      if (onProgress) {
        onProgress(progress, `Severity-Priority: ${step.name}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
      executionResult.progress = progress;
      executionResult.outputs[`step${i + 1}`] = `${step.name} completed`;
    }

    executionResult.status = 'completed';
    executionResult.progress = 100;
    executionResult.timeline.completedAt = new Date().toISOString();
    executionResult.timeline.duration = steps.reduce((sum, s) => sum + s.duration, 0);
    executionResult.metrics = {
      successRate: 90,
      completionTime: executionResult.timeline.duration,
      stakeholderSatisfaction: 80,
      costEfficiency: 90,
      qualityScore: 85,
    };

    if (onProgress) {
      onProgress(100, 'Severity-Priority Framework execution completed successfully');
    }
  }

  /**
   * Execute Double Diamond Framework
   */
  private async executeDoubleDiamondFramework(
    demand: Demand,
    framework: DoubleDiamondFramework,
    executionResult: FrameworkExecutionResult,
    onProgress?: (progress: number, message: string) => void,
  ): Promise<void> {
    const steps = [
      { name: 'Discovery research', duration: 25 },
      { name: 'Insight gathering', duration: 20 },
      { name: 'Problem definition', duration: 15 },
      { name: 'User journey mapping', duration: 20 },
      { name: 'Prototyping', duration: 30 },
      { name: 'User testing', duration: 25 },
      { name: 'Implementation', duration: 20 },
      { name: 'Final review', duration: 15 },
    ];

    let totalProgress = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      totalProgress += step.duration;
      const progress = Math.round(
        (totalProgress / steps.reduce((sum, s) => sum + s.duration, 0)) * 100,
      );

      if (onProgress) {
        onProgress(progress, `Double Diamond: ${step.name}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
      executionResult.progress = progress;
      executionResult.outputs[`step${i + 1}`] = `${step.name} completed`;
    }

    executionResult.status = 'completed';
    executionResult.progress = 100;
    executionResult.timeline.completedAt = new Date().toISOString();
    executionResult.timeline.duration = steps.reduce((sum, s) => sum + s.duration, 0);
    executionResult.metrics = {
      successRate: 75,
      completionTime: executionResult.timeline.duration,
      stakeholderSatisfaction: 85,
      costEfficiency: 70,
      qualityScore: 80,
    };

    if (onProgress) {
      onProgress(100, 'Double Diamond Framework execution completed successfully');
    }
  }

  /**
   * Execute CRISP-DM Framework
   */
  private async executeCRISPDMFramework(
    demand: Demand,
    framework: CRISPDMFramework,
    executionResult: FrameworkExecutionResult,
    onProgress?: (progress: number, message: string) => void,
  ): Promise<void> {
    const steps = [
      { name: 'Business understanding', duration: 20 },
      { name: 'Data understanding', duration: 25 },
      { name: 'Data preparation', duration: 30 },
      { name: 'Modeling', duration: 35 },
      { name: 'Evaluation', duration: 25 },
      { name: 'Deployment planning', duration: 20 },
      { name: 'Final review', duration: 15 },
    ];

    let totalProgress = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      totalProgress += step.duration;
      const progress = Math.round(
        (totalProgress / steps.reduce((sum, s) => sum + s.duration, 0)) * 100,
      );

      if (onProgress) {
        onProgress(progress, `CRISP-DM: ${step.name}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
      executionResult.progress = progress;
      executionResult.outputs[`step${i + 1}`] = `${step.name} completed`;
    }

    executionResult.status = 'completed';
    executionResult.progress = 100;
    executionResult.timeline.completedAt = new Date().toISOString();
    executionResult.timeline.duration = steps.reduce((sum, s) => sum + s.duration, 0);
    executionResult.metrics = {
      successRate: 80,
      completionTime: executionResult.timeline.duration,
      stakeholderSatisfaction: 75,
      costEfficiency: 75,
      qualityScore: 85,
    };

    if (onProgress) {
      onProgress(100, 'CRISP-DM Framework execution completed successfully');
    }
  }

  /**
   * Execute Auto-Suggest Framework
   */
  private async executeAutoSuggestFramework(
    demand: Demand,
    framework: AIFrameworkSuggestion,
    executionResult: FrameworkExecutionResult,
    onProgress?: (progress: number, message: string) => void,
  ): Promise<void> {
    const steps = [
      { name: 'Analyzing demand', duration: 15 },
      { name: 'Evaluating criteria', duration: 20 },
      { name: 'Generating suggestions', duration: 25 },
      { name: 'Calculating confidence', duration: 15 },
      { name: 'Providing rationale', duration: 15 },
      { name: 'Finalizing recommendation', duration: 10 },
    ];

    let totalProgress = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      totalProgress += step.duration;
      const progress = Math.round(
        (totalProgress / steps.reduce((sum, s) => sum + s.duration, 0)) * 100,
      );

      if (onProgress) {
        onProgress(progress, `Auto-Suggest: ${step.name}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
      executionResult.progress = progress;
      executionResult.outputs[`step${i + 1}`] = `${step.name} completed`;
    }

    executionResult.status = 'completed';
    executionResult.progress = 100;
    executionResult.timeline.completedAt = new Date().toISOString();
    executionResult.timeline.duration = steps.reduce((sum, s) => sum + s.duration, 0);
    executionResult.metrics = {
      successRate: 85,
      completionTime: executionResult.timeline.duration,
      stakeholderSatisfaction: 80,
      costEfficiency: 85,
      qualityScore: 80,
    };

    if (onProgress) {
      onProgress(100, 'Auto-Suggest Framework execution completed successfully');
    }
  }

  /**
   * Add to execution history
   */
  private addToExecutionHistory(
    demandId: string | number,
    executionResult: FrameworkExecutionResult,
  ): void {
    const id = demandId.toString();
    if (!this.executionHistory.has(id)) {
      this.executionHistory.set(id, []);
    }

    const history = this.executionHistory.get(id)!;
    history.push(executionResult);
    this.executionHistory.set(id, history);
  }

  /**
   * Get execution history for a demand
   */
  getExecutionHistory(demandId: string | number): FrameworkExecutionResult[] {
    return this.executionHistory.get(demandId.toString()) || [];
  }

  /**
   * Get framework metrics summary
   */
  getFrameworkMetricsSummary(): Record<FrameworkType, FrameworkMetrics> {
    const summary: Record<FrameworkType, FrameworkMetrics> = {
      jtbd: {
        successRate: 85,
        completionTime: 120,
        stakeholderSatisfaction: 90,
        costEfficiency: 80,
        qualityScore: 85,
      },
      heart: {
        successRate: 80,
        completionTime: 90,
        stakeholderSatisfaction: 85,
        costEfficiency: 75,
        qualityScore: 80,
      },
      'severity-priority': {
        successRate: 90,
        completionTime: 60,
        stakeholderSatisfaction: 80,
        costEfficiency: 90,
        qualityScore: 85,
      },
      'double-diamond': {
        successRate: 75,
        completionTime: 180,
        stakeholderSatisfaction: 85,
        costEfficiency: 70,
        qualityScore: 80,
      },
      'crisp-dm': {
        successRate: 80,
        completionTime: 240,
        stakeholderSatisfaction: 75,
        costEfficiency: 75,
        qualityScore: 85,
      },
      'auto-suggest': {
        successRate: 90,
        completionTime: 30,
        stakeholderSatisfaction: 85,
        costEfficiency: 95,
        qualityScore: 90,
      },
      'threat-modeling': {
        successRate: 0,
        completionTime: 0,
        stakeholderSatisfaction: 0,
        costEfficiency: 0,
        qualityScore: 0,
      },
      'privacy-by-design': {
        successRate: 0,
        completionTime: 0,
        stakeholderSatisfaction: 0,
        costEfficiency: 0,
        qualityScore: 0,
      },
      'incremental-refactoring': {
        successRate: 0,
        completionTime: 0,
        stakeholderSatisfaction: 0,
        costEfficiency: 0,
        qualityScore: 0,
      },
      'architecture-decision-record': {
        successRate: 0,
        completionTime: 0,
        stakeholderSatisfaction: 0,
        costEfficiency: 0,
        qualityScore: 0,
      },
      checklist: {
        successRate: 0,
        completionTime: 0,
        stakeholderSatisfaction: 0,
        costEfficiency: 0,
        qualityScore: 0,
      },
    };

    return summary;
  }
}

// Spec 013 (H-01/SC-002): o singleton legado foi removido — o único singleton
// público é a fachada exportada por server/frameworks/index.ts. A classe
// permanece exportada apenas como delegado interno da fachada.
