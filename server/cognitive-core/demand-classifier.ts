import { resolvePath } from '@shared/utils/paths';
import { Demand } from '@shared/schema';
import { demandRepository } from '../repositories/demand-repository';
import {
  DEMAND_TYPES,
  getDemandTypeConfig,
  isDemandType,
  type DemandRegistryCategory,
} from '@shared/demand-types';
import { validateContract } from '../services/model-governance';
import { FAST_MODEL, CAPABLE_MODEL } from '../services/llm-model-router';
import { agentRouterService } from '../services/agent-router';
import { eventBus } from '../events/event-bus';
import { classifyDemandVagueness } from '../services/hybrid-classifier';
import { logger } from '../utils/logger';
import { hybridClassifierComparison, featureFlagIoErrorTotal } from '../metrics';
import { generateRequestId } from '../utils/request-id';
import { dispatchLogger } from '../services/dispatch-logger';
import * as fs from 'fs';
import {
  type DemandClassification,
  type DemandCategory,
  type ClassificationCriteria,
  type PersonalReadinessScore,
  type ProgressiveRefinementTriage,
  type RouterClassificationContract,
} from '../orchestration-contracts';

export type {
  DemandClassification,
  DemandCategory,
  ClassificationCriteria,
  PersonalReadinessScore,
  ProgressiveRefinementTriage,
  RouterClassificationContract,
} from '../orchestration-contracts';

/**
 * Keywords that indicate specific categories
 */
const CATEGORY_KEYWORDS: Record<DemandCategory, string[]> = {
  technical: [
    'api',
    'database',
    'integration',
    'backend',
    'frontend',
    'code',
    'algorithm',
    'server',
    'deployment',
    'infrastructure',
    // Portuguese
    'banco de dados',
    'integração',
    'código',
    'algoritmo',
    'servidor',
    'sistema',
  ],
  legal: [
    'contract',
    'compliance',
    'regulation',
    'law',
    'legal',
    'gdpr',
    'privacy',
    'terms',
    'policy',
    'agreement',
    // Portuguese
    'contrato',
    'regulação',
    'lei',
    'privacidade',
    'termos',
    'política',
    'acordo',
    'norma',
  ],
  creative: [
    'design',
    'ux',
    'ui',
    'branding',
    'creative',
    'art',
    'visual',
    'aesthetic',
    'user experience',
    'prototype',
    // Portuguese
    'criativo',
    'arte',
    'estética',
    'protótipo',
    'experiência do usuário',
  ],
  business: [
    'market',
    'strategy',
    'revenue',
    'profit',
    'business',
    'sales',
    'marketing',
    'customer',
    'product',
    'growth',
    // Portuguese
    'mercado',
    'estratégia',
    'receita',
    'lucro',
    'negócio',
    'vendas',
    'cliente',
    'produto',
    'crescimento',
    'go-to-market',
    'enterprise',
    'segmento',
  ],
  analytical: [
    'data',
    'analysis',
    'report',
    'metrics',
    'analytics',
    'statistics',
    'insights',
    'trends',
    'dashboard',
    'kpi',
    // Portuguese
    'dados',
    'análise',
    'relatório',
    'métricas',
    'estatística',
    'tendências',
    'cotação',
    'fechamento',
    // Additional analytical keywords
    'funil',
    'conversão',
    'indicadores',
    'indicador',
    'tendência',
    'previsão',
    'preditiva',
    'comportamento',
    'histórico',
    'comparativa',
    'utilização',
    'saúde do produto',
    'churn',
    'report',
  ],
  support: [
    'help',
    'support',
    'issue',
    'problem',
    'error',
    'bug',
    'ticket',
    'customer service',
    'troubleshoot',
    'resolve',
    // Portuguese - general support
    'ajuda',
    'suporte',
    'problema',
    'erro',
    'falha',
    'urgente',
    'resolver',
    'corrigir',
    'não funciona',
    'dando erro',
    // User-facing issues (support tickets)
    'não consigo',
    'não está',
    'não aceita',
    'não recebo',
    'não estou',
    'perdi acesso',
    'senha errada',
    'sessão expira',
    'travando',
    'crashando',
    'muito lento',
    'carregando infinitamente',
    'fica carregando',
    'sai cortada',
    'desatualizados',
    'deletados por engano',
    // User actions
    'cliente reportou',
    'preciso recuperar',
    'preciso de ajuda',
  ],
  research: [
    'research',
    'study',
    'explore',
    'investigate',
    'discovery',
    'findings',
    'hypothesis',
    'experiment',
    'survey',
    'analysis',
    // Portuguese
    'pesquisa',
    'estudo',
    'explorar',
    'investigar',
    'descoberta',
    'hipótese',
    'experimento',
  ],
};

const CLASSIFIER_CATEGORIES: DemandCategory[] = [
  'technical',
  'legal',
  'creative',
  'business',
  'analytical',
  'support',
  'research',
];

function toClassifierCategory(category: DemandRegistryCategory): DemandCategory {
  if (category === 'regulatory') return 'legal';
  if (category === 'product' || category === 'mixed') return 'business';
  return category;
}

function initialCategoryScores(): Record<DemandCategory, number> {
  return Object.fromEntries(CLASSIFIER_CATEGORIES.map((category) => [category, 0])) as Record<
    DemandCategory,
    number
  >;
}

function registryAgentsForCategory(category: DemandCategory): string[] {
  const agents = Object.values(DEMAND_TYPES)
    .filter((config) => {
      const classifierCategory = toClassifierCategory(config.category);
      return (
        classifierCategory === category ||
        Object.prototype.hasOwnProperty.call(config.classifierScoreAdjustments, category)
      );
    })
    .flatMap((config) => config.squad);

  if (agents.length > 0) {
    return Array.from(new Set(agents));
  }

  return Array.from(new Set(Object.values(DEMAND_TYPES).flatMap((config) => config.squad)));
}

/**
 * Demand Classifier - Intelligent classifier for categorizing demands
 */
export class DemandClassifier {
  /**
   * Classifies a demand based on its content and context
   * @param demand - The demand to classify
   * @returns Classification result
   */
  async classifyDemand(demand: Demand): Promise<DemandClassification> {
    logger.warn(
      '[DemandClassifier] classifyDemand is deprecated and will be unified with agent-router.ts',
      {
        context: {
          demandId: demand.id,
          recommendation: 'Use agentRouterService.classifyDemandForRouting() for new code',
        },
      },
    );

    // Spec 10126 T3: delegate classification to agent-router.ts while keeping
    // the legacy DemandClassification contract for existing consumers.
    if (this.isAgentRouterDelegationEnabled()) {
      return this.classifyDemandViaRouter(demand);
    }

    const requestId = generateRequestId();
    const startTime = Date.now();
    let stepStart = startTime;

    // Step 1: Analyze criteria
    const criteria = this.analyzeClassificationCriteria(demand);
    const criteriaMs = Date.now() - stepStart;
    stepStart = Date.now();

    // Step 2: Determine category
    const category = this.determineCategory(demand, criteria);
    const categoryMs = Date.now() - stepStart;
    stepStart = Date.now();

    // Step 3: Calculate confidence
    const confidence = this.calculateConfidence(demand, criteria, category);
    const confidenceMs = Date.now() - stepStart;
    stepStart = Date.now();

    // Step 4: Get recommended agents
    const recommendedAgents = this.getRecommendedAgents(demand, category, criteria);
    const agentsMs = Date.now() - stepStart;
    stepStart = Date.now();

    // Step 5: Calculate personal readiness
    const personalReadiness = this.calculatePersonalReadiness(demand, criteria);
    const readinessMs = Date.now() - stepStart;
    stepStart = Date.now();

    // Step 6: Calculate progressive refinement
    const progressiveRefinement = this.calculateProgressiveRefinement(demand, criteria);
    const refinementMs = Date.now() - stepStart;
    stepStart = Date.now();

    // Step 7: Generate notes
    const notes = this.generateClassificationNotes(demand, criteria, category, personalReadiness);

    // Generate router contract for hybrid model routing
    const routerContract = this.generateRouterContract(
      demand,
      criteria,
      category,
      recommendedAgents,
    );

    const result: DemandClassification = {
      category,
      criteria,
      confidence,
      recommendedAgents,
      notes,
      personalReadiness,
      progressiveRefinement,
      routerContract,
    };

    // Hybrid vagueness classification (feature-flag gated)
    let hybridMs = 0;
    if (this.isHybridClassifierEnabled(requestId)) {
      stepStart = Date.now();
      try {
        const vagueness = await classifyDemandVagueness(demand.title, demand.description);
        result.hybridVagueness = vagueness;

        // B3 shadow: registra divergência entre a heurística rule-only e o híbrido
        // (embedding) na zona ambígua, SEM alterar a decisão. As métricas de
        // zona/latência/custo já são emitidas dentro de classifyDemandVagueness.
        if (vagueness.method === 'hybrid') {
          const ruleOnlyLabel = vagueness.ruleScore >= 50 ? 'vaga' : 'nao_vaga';
          const comparisonResult = ruleOnlyLabel !== vagueness.label ? 'divergent' : 'match';
          hybridClassifierComparison.labels(comparisonResult).inc();
          logger.info('[HybridShadow] comparação rule-only vs híbrido', {
            context: {
              demandId: demand.id,
              ruleScore: vagueness.ruleScore,
              ruleOnlyLabel,
              hybridLabel: vagueness.label,
              agreement: comparisonResult,
            },
          });
        }

        // Influência na decisão atrás de flag própria (B3). Em shadow (default)
        // o híbrido NÃO altera nada; liga-se só após o shadow confirmar ganho.
        if (
          this.isHybridInfluenceEnabled(requestId) &&
          vagueness.label === 'vaga' &&
          vagueness.method === 'hybrid'
        ) {
          result.criteria.ambiguity = Math.max(result.criteria.ambiguity, 65);
          if (!result.recommendedAgents.includes('product_owner')) {
            result.recommendedAgents.unshift('product_owner');
          }
        }
      } catch (error) {
        logger.warn('Hybrid vagueness classification failed (non-blocking)', {
          context: {
            requestId,
            demandId: demand.id,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
      hybridMs = Date.now() - stepStart;
    }

    // Validar contrato mínimo de saída (T3)
    const isValid = !!(
      result.category &&
      result.criteria &&
      result.recommendedAgents &&
      result.recommendedAgents.length > 0
    );
    validateContract(
      isValid,
      'DemandClassifier',
      'cognitive-core/demand-classifier.ts',
      'mistral-medium-3.5', // Modelo oficial na configuração
      'Objeto de classificação incompleto (category, criteria ou agents ausentes)',
    );

    // Log structured classification result
    const totalMs = Date.now() - startTime;
    logger.info('Demand classified', {
      context: {
        requestId,
        demandId: demand.id,
        step: 'classify_demand',
        category,
        confidence,
        agents: recommendedAgents.join(','),
        readinessLevel: personalReadiness.level,
        refinementLevel: progressiveRefinement.recommendedLevel,
        durationMs: totalMs,
        steps: {
          criteria_ms: criteriaMs,
          category_ms: categoryMs,
          confidence_ms: confidenceMs,
          agents_ms: agentsMs,
          readiness_ms: readinessMs,
          refinement_ms: refinementMs,
          hybrid_ms: hybridMs,
        },
      },
    });

    eventBus.publish('DEMAND_ANALYSIS_COMPLETED', {
      demandId: demand.id,
      classification: result,
      timestamp: new Date().toISOString(),
    });

    // M4: log dispatch (LOG 1) — routing_output vs modelo recomendado.
    const specForHash = `${demand.title}\n${demand.description}`;
    dispatchLogger.logDispatch(
      specForHash,
      result.routerContract?.tipo_demanda ?? demand.type ?? 'unknown',
      result.routerContract?.modelo_recomendado ?? 'unknown',
    );

    return result;
  }

  /**
   * Check if hybrid classifier feature flag is enabled.
   */
  private isHybridClassifierEnabled(operationId: string): boolean {
    const flagsPath = resolvePath('config/feature-flags.json');
    try {
      if (fs.existsSync(flagsPath)) {
        const flags = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
        return flags.enableHybridClassifier === true;
      }
      return false;
    } catch (error) {
      const code = (
        error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN'
      ) as string;
      featureFlagIoErrorTotal.labels({ file: flagsPath, error_code: code }).inc();
      logger.error('Feature flag IO error — enableHybridClassifier', {
        context: {
          operationId,
          component: 'demand-classifier',
          flag_path: flagsPath,
          error_code: code,
        },
        error,
      });
      return false;
    }
  }

  /**
   * B3: a influência do híbrido na decisão é gated por flag SEPARADA. Com o
   * híbrido ligado mas a influência off, ele roda em SHADOW (observa/registra
   * divergência sem mudar a classificação). Promove-se ligando esta flag depois
   * que o shadow confirmar o ganho.
   */
  private isHybridInfluenceEnabled(operationId: string): boolean {
    const flagsPath = resolvePath('config/feature-flags.json');
    try {
      if (fs.existsSync(flagsPath)) {
        const flags = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
        return flags.hybridClassifierInfluenceEnabled === true;
      }
      return false;
    } catch (error) {
      const code = (
        error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN'
      ) as string;
      featureFlagIoErrorTotal.labels({ file: flagsPath, error_code: code }).inc();
      logger.error('Feature flag IO error — hybridClassifierInfluenceEnabled', {
        context: {
          operationId,
          component: 'demand-classifier',
          flag_path: flagsPath,
          error_code: code,
        },
        error,
      });
      return false;
    }
  }

  /**
   * Generates Router Classification Contract for hybrid model routing
   * Used to determine whether to use gpt-5.4-nano or gpt-5.4-mini
   */
  private generateRouterContract(
    demand: Demand,
    criteria: ClassificationCriteria,
    category: DemandCategory,
    recommendedAgents: string[],
  ): RouterClassificationContract {
    // Map demand type to tipo_demanda
    const tipoMap: Record<string, RouterClassificationContract['tipo_demanda']> = {
      bug: 'bug',
      feature: 'feature',
      melhoria: 'melhoria',
      improvement: 'melhoria',
      discovery: 'discovery',
      spike: 'spike',
      debito: 'debito_tecnico',
      debt: 'debito_tecnico',
      doc: 'documentacao',
      documentation: 'documentacao',
      analysis: 'analise_tecnica',
      analise_exploratoria: 'analise_tecnica',
      nova_funcionalidade: 'feature',
      security: 'security',
      refactoring: 'refactoring',
      infraestrutura: 'infraestrutura',
    };
    const tipo_demanda = tipoMap[demand.type?.toLowerCase()] || 'feature';

    // Map complexity to Portuguese
    const complexidade: RouterClassificationContract['complexidade'] =
      criteria.complexity >= 70 ? 'alta' : criteria.complexity >= 40 ? 'media' : 'baixa';

    // Map risk to Portuguese
    const risco: RouterClassificationContract['risco'] =
      criteria.interpretationRisk >= 70
        ? 'alto'
        : criteria.interpretationRisk >= 40
          ? 'medio'
          : 'baixo';

    // Map ambiguity to clarity (inverted)
    const clareza_da_demanda: RouterClassificationContract['clareza_da_demanda'] =
      criteria.ambiguity <= 30 ? 'alta' : criteria.ambiguity <= 60 ? 'media' : 'baixa';

    // Map urgency/priority to business impact
    let impacto_negocio: RouterClassificationContract['impacto_negocio'] = 'medio';
    if (demand.priority === 'critica' || criteria.urgency >= 90) {
      impacto_negocio = 'critico';
    } else if (demand.priority === 'alta' || criteria.urgency >= 70) {
      impacto_negocio = 'alto';
    } else if (demand.priority === 'baixa' && criteria.urgency < 40) {
      impacto_negocio = 'baixo';
    }

    // Determine flags based on category and agents
    const text = `${demand.title} ${demand.description}`.toLowerCase();
    const necessita_codigo = !['discovery', 'documentacao'].includes(tipo_demanda);
    const necessita_arquitetura =
      criteria.complexity >= 70 ||
      text.includes('arquitetura') ||
      text.includes('refatoração') ||
      recommendedAgents.includes('tech_lead');
    const necessita_ux =
      category === 'creative' ||
      recommendedAgents.includes('ux_designer') ||
      text.includes('usuário') ||
      text.includes('interface') ||
      text.includes('tela');
    const necessita_qa = true; // Always need QA
    const necessita_prd = tipo_demanda !== 'bug' || criteria.complexity >= 70;
    const necessita_dados =
      category === 'analytical' ||
      recommendedAgents.includes('analista_de_dados') ||
      text.includes('dados') ||
      text.includes('relatório') ||
      text.includes('integração');

    // Determine recommended model based on rules:
    // - Simple demands (low complexity + low risk + high clarity): nano
    // - Everything else: mini
    const modelo_recomendado: RouterClassificationContract['modelo_recomendado'] =
      complexidade === 'baixa' && risco === 'baixo' && clareza_da_demanda === 'alta'
        ? FAST_MODEL
        : CAPABLE_MODEL;

    // Build justificativa
    const justificativa =
      `Classificado como ${tipo_demanda} com ${complexidade} complexidade, ${risco} risco, ${clareza_da_demanda} clareza. ` +
      `Modelo ${modelo_recomendado} recomendado. ` +
      (necessita_arquitetura ? 'Requer análise de arquitetura. ' : '') +
      (necessita_ux ? 'Requer avaliação de UX. ' : '') +
      (necessita_dados ? 'Requer análise de dados. ' : '');

    return {
      tipo_demanda,
      complexidade,
      risco,
      clareza_da_demanda,
      impacto_negocio,
      necessita_codigo,
      necessita_arquitetura,
      necessita_ux,
      necessita_qa,
      necessita_prd,
      necessita_dados,
      modelo_recomendado,
      agentes_recomendados: recommendedAgents,
      justificativa: justificativa.trim(),
    };
  }

  /**
   * Analyzes classification criteria for a demand
   * @param demand - The demand to analyze
   * @returns Classification criteria
   */
  private analyzeClassificationCriteria(demand: Demand): ClassificationCriteria {
    const description = demand.description.toLowerCase();
    const title = demand.title.toLowerCase();
    const combinedText = `${title} ${description}`;

    // Calculate ambiguity (based on vague language)
    const ambiguity = this.calculateAmbiguity(combinedText);

    // Calculate interpretation risk (based on potential for misunderstanding)
    const interpretationRisk = this.calculateInterpretationRisk(combinedText);

    // Calculate depth required (based on complexity indicators)
    const depthRequired = this.calculateDepthRequired(combinedText);

    // Calculate complexity (based on technical terms and scope)
    const complexity = this.calculateComplexity(combinedText);

    // Calculate urgency (based on priority and keywords)
    const urgency = this.calculateUrgency(demand);

    return {
      ambiguity,
      interpretationRisk,
      depthRequired,
      complexity,
      urgency,
    };
  }

  /**
   * Calculates ambiguity score
   * @param text - Text to analyze
   * @returns Ambiguity score (0-100)
   */
  private calculateAmbiguity(text: string): number {
    const vagueWords = [
      'maybe',
      'possibly',
      'could',
      'might',
      'perhaps',
      'some',
      'various',
      'different',
      'several',
      'many',
    ];
    let score = 0;

    vagueWords.forEach((word) => {
      if (text.includes(word)) score += 5;
    });

    // Longer descriptions tend to be more ambiguous
    if (text.length > 500) score += 10;
    if (text.length > 1000) score += 15;

    // Question marks indicate uncertainty
    const questionMarks = (text.match(/\?/g) || []).length;
    score += questionMarks * 3;

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Calculates interpretation risk score
   * @param text - Text to analyze
   * @returns Interpretation risk score (0-100)
   */
  private calculateInterpretationRisk(text: string): number {
    const riskyPhrases = [
      'as needed',
      'if possible',
      'when appropriate',
      'depending on',
      'subject to',
      'based on',
      'according to',
      'as per',
    ];

    let score = 0;
    riskyPhrases.forEach((phrase) => {
      if (text.includes(phrase)) score += 8;
    });

    // Multiple stakeholders increase risk
    const stakeholders = ['team', 'department', 'group', 'stakeholder', 'client', 'customer'];
    const stakeholderCount = stakeholders.filter((word) => text.includes(word)).length;
    score += stakeholderCount * 5;

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Calculates depth required score
   * @param text - Text to analyze
   * @returns Depth required score (0-100)
   */
  private calculateDepthRequired(text: string): number {
    const depthIndicators = [
      'comprehensive',
      'detailed',
      'thorough',
      'complete',
      'in-depth',
      'extensive',
      'full',
      'complete',
      'exhaustive',
    ];

    let score = 20; // Base score

    depthIndicators.forEach((indicator) => {
      if (text.includes(indicator)) score += 10;
    });

    // Longer descriptions indicate more depth needed
    if (text.length > 300) score += 15;
    if (text.length > 800) score += 25;

    // Multiple requirements increase depth
    const requirements = ['requirement', 'need', 'must', 'should', 'require'];
    const requirementCount = requirements.filter((word) => text.includes(word)).length;
    score += requirementCount * 5;

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Calculates complexity score
   * @param text - Text to analyze
   * @returns Complexity score (0-100)
   */
  private calculateComplexity(text: string): number {
    const complexTerms = [
      'integration',
      'migration',
      'refactoring',
      'scalability',
      'performance',
      'security',
      'authentication',
      'authorization',
      'database',
      'api',
      'microservice',
      'architecture',
      'infrastructure',
      'deployment',
      'containerization',
    ];

    let score = 30; // Base score

    complexTerms.forEach((term) => {
      if (text.includes(term)) score += 8;
    });

    // Multiple systems increase complexity
    const systems = ['system', 'service', 'module', 'component', 'application'];
    const systemCount = systems.filter((word) => text.includes(word)).length;
    score += systemCount * 7;

    // Technical jargon increases complexity
    const jargon = [
      'rest',
      'graphql',
      'websocket',
      'kafka',
      'redis',
      'docker',
      'kubernetes',
      'aws',
      'azure',
      'gcp',
    ];
    const jargonCount = jargon.filter((word) => text.includes(word)).length;
    score += jargonCount * 6;

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Calculates urgency score
   * @param demand - The demand to analyze
   * @returns Urgency score (0-100)
   */
  private calculateUrgency(demand: Demand): number {
    let score = 0;

    // Priority-based urgency
    switch (demand.priority) {
      case 'critica':
        score = 90;
        break;
      case 'alta':
        score = 70;
        break;
      case 'media':
        score = 50;
        break;
      case 'baixa':
        score = 30;
        break;
      default:
        score = 40;
    }

    // Urgent keywords
    const urgentKeywords = [
      'urgent',
      'immediate',
      'asap',
      'critical',
      'priority',
      'emergency',
      'now',
      'today',
      'tomorrow',
    ];
    urgentKeywords.forEach((keyword) => {
      if (demand.description.toLowerCase().includes(keyword)) score += 5;
    });

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Determines the category for a demand
   * @param demand - The demand to categorize
   * @param criteria - Classification criteria
   * @returns Demand category
   */
  private determineCategory(demand: Demand, criteria: ClassificationCriteria): DemandCategory {
    if (isDemandType(demand.type)) {
      return toClassifierCategory(getDemandTypeConfig(demand.type).category);
    }

    const text = `${demand.title} ${demand.description}`.toLowerCase();
    const categoryScores = initialCategoryScores();

    // Score based on keywords
    const keywordMatches = Object.fromEntries(
      CLASSIFIER_CATEGORIES.map((category) => [category, []]),
    ) as unknown as Record<DemandCategory, string[]>;

    for (const category in CATEGORY_KEYWORDS) {
      const keywords = CATEGORY_KEYWORDS[category as DemandCategory];
      keywords.forEach((keyword) => {
        if (text.includes(keyword)) {
          categoryScores[category as DemandCategory] += 10;
          keywordMatches[category as DemandCategory].push(keyword);
        }
      });
    }

    // Context-aware adjustments to reduce false positives
    // If "problema" or "erro" appears but there are strong technical keywords,
    // reduce support score (it's likely a technical problem description, not a support ticket)
    const hasTechnicalContext = keywordMatches.technical.some((k) =>
      [
        'api',
        'database',
        'backend',
        'frontend',
        'código',
        'servidor',
        'sistema',
        'banco de dados',
        'deploy',
        'docker',
        'pipeline',
      ].includes(k),
    );
    const hasBusinessContext = keywordMatches.business.some((k) =>
      [
        'estratégia',
        'receita',
        'mercado',
        'vendas',
        'marketing',
        'produto',
        'crescimento',
        'roi',
        'pricing',
      ].includes(k),
    );

    // If support keywords appear alongside strong technical keywords, discount support
    if (hasTechnicalContext && keywordMatches.support.length > 0) {
      categoryScores.support -= 15; // Reduce support score
    }

    // If support keywords appear alongside strong business keywords, discount support
    if (hasBusinessContext && keywordMatches.support.length > 0) {
      categoryScores.support -= 10;
    }

    // Strong support indicators (these should override technical context)
    const strongSupportIndicators = [
      'erro 500',
      'erro 403',
      'erro 404',
      'erro ao',
      'não funciona',
      'dando erro',
      'crashando',
      'travando',
      'urgente',
      'cliente reportou',
      'preciso de ajuda',
      'não consigo',
      'perdi acesso',
      'sessão expira',
      'valores estão sendo calculados errado',
      'calculados errado',
      'não estou recebendo',
      'sai cortada',
      'dados desatualizados',
    ];
    const hasStrongSupportIndicator = strongSupportIndicators.some((indicator) =>
      text.includes(indicator),
    );
    if (hasStrongSupportIndicator) {
      categoryScores.support += 25; // Strong boost for clear support issues
    }

    // Technical infrastructure keywords that should NOT be support even with "erro"
    const infraKeywords = [
      'docker',
      'dockerfile',
      'container',
      'pipeline',
      'ci/cd',
      'deploy',
      'kubernetes',
      'k8s',
    ];
    const hasInfraKeywords = infraKeywords.some((k) => text.includes(k));
    if (hasInfraKeywords && !hasStrongSupportIndicator) {
      categoryScores.technical += 20;
      categoryScores.support -= 20;
    }

    // Business-specific keywords that should boost business over technical
    const strongBusinessKeywords = [
      'break-even',
      'parceria',
      'fornecedores',
      'projeção',
      'faturamento',
      'aumento de preço',
      'churn',
      'metas de vendas',
      'equipe comercial',
    ];
    const hasStrongBusinessKeywords = strongBusinessKeywords.some((k) => text.includes(k));
    if (hasStrongBusinessKeywords) {
      categoryScores.business += 15;
    }

    // Support-specific: user-facing issues that stopped working
    const userFacingIssues = [
      'parou de funcionar',
      'deu timeout',
      'correção necessária',
      'imposto está errado',
      'valor está errado',
    ];
    const hasUserFacingIssue = userFacingIssues.some((k) => text.includes(k));
    if (hasUserFacingIssue) {
      categoryScores.support += 20;
    }

    // Technical-specific: GraphQL, endpoint, upload (dev tasks, not support)
    const devTaskKeywords = ['graphql', 'endpoint', 'upload', 'lambda', 'microserviço'];
    const hasDevTask = devTaskKeywords.some((k) => text.includes(k));
    if (hasDevTask) {
      categoryScores.technical += 15;
    }

    // Analytical-specific: "relatório de" should be analytical, not business
    if (text.includes('relatório de') || text.includes('report de')) {
      categoryScores.analytical += 15;
    }

    // Adjust scores based on classification criteria
    if (criteria.complexity > 70) categoryScores.technical += 15;
    if (criteria.ambiguity > 60) categoryScores.research += 10;
    if (criteria.depthRequired > 80) categoryScores.analytical += 12;
    if (criteria.urgency > 80) categoryScores.support += 10;

    // Adjust based on demand type using centralized config
    if (isDemandType(demand.type)) {
      const typeConfig = getDemandTypeConfig(demand.type);
      const adjustments = typeConfig.classifierScoreAdjustments;
      for (const [category, adjustment] of Object.entries(adjustments)) {
        if (category in categoryScores && typeof adjustment === 'number') {
          categoryScores[category as DemandCategory] += adjustment;
        }
      }
    }

    // Find the category with the highest score
    let highestScore = -1;
    let selectedCategory: DemandCategory = 'technical'; // default

    for (const category in categoryScores) {
      if (categoryScores[category as DemandCategory] > highestScore) {
        highestScore = categoryScores[category as DemandCategory];
        selectedCategory = category as DemandCategory;
      }
    }

    return selectedCategory;
  }

  /**
   * Calculates confidence in the classification
   * @param demand - The demand
   * @param criteria - Classification criteria
   * @param category - Determined category
   * @returns Confidence score (0-100)
   */
  private calculateConfidence(
    demand: Demand,
    criteria: ClassificationCriteria,
    category: DemandCategory,
  ): number {
    let confidence = 50; // Base confidence

    // Higher criteria scores increase confidence
    const avgCriteria =
      (criteria.ambiguity +
        criteria.interpretationRisk +
        criteria.depthRequired +
        criteria.complexity +
        criteria.urgency) /
      5;
    confidence += Math.min(30, avgCriteria * 0.5);

    // Keyword matches increase confidence
    const text = `${demand.title} ${demand.description}`.toLowerCase();
    const keywords = CATEGORY_KEYWORDS[category];
    const keywordMatches = keywords.filter((keyword) => text.includes(keyword)).length;
    confidence += Math.min(20, keywordMatches * 3);

    // High ambiguity decreases confidence
    if (criteria.ambiguity > 70) confidence -= 15;

    // High interpretation risk decreases confidence
    if (criteria.interpretationRisk > 60) confidence -= 10;

    return Math.min(100, Math.max(30, confidence));
  }

  /**
   * Gets recommended agents for a category
   * @param category - Demand category
   * @param criteria - Classification criteria
   * @returns Array of recommended agent names
   */
  private getRecommendedAgents(
    demand: Demand,
    category: DemandCategory,
    criteria: ClassificationCriteria,
  ): string[] {
    const agents = isDemandType(demand.type)
      ? [...getDemandTypeConfig(demand.type).squad]
      : registryAgentsForCategory(category);

    if (demand.domain === 'legaltech_lgpd' && !agents.includes('security_specialist')) {
      agents.unshift('security_specialist');
    }

    // Add analista_de_dados for technical demands with high depth or data focus
    if (
      category === 'technical' &&
      (criteria.depthRequired > 70 || criteria.complexity > 80) &&
      !agents.includes('analista_de_dados')
    ) {
      agents.push('analista_de_dados');
    }

    // Add product_owner only for genuinely ambiguous queries
    // Much stricter thresholds to keep ambiguity rate ≤15%
    const shouldAddRefinador =
      criteria.ambiguity > 85 || // Very high ambiguity only
      (criteria.interpretationRisk > 80 && criteria.ambiguity > 70); // Combined high risk

    if (shouldAddRefinador && !agents.includes('product_owner')) {
      agents.unshift('product_owner');
    }

    // Add scrum_master for high complexity (already in base for some, but double check)
    if (criteria.complexity > 75 && !agents.includes('scrum_master')) {
      agents.push('scrum_master');
    }

    return Array.from(new Set(agents)); // Remove duplicates
  }

  /**
   * Checks if the classification has low keyword confidence.
   * Used to trigger product_owner for ambiguous queries that don't match many keywords.
   * @param category - Current category
   * @param criteria - Classification criteria (used for context)
   * @returns true if keyword confidence is low
   */
  private hasLowKeywordConfidence(
    category: DemandCategory,
    criteria: ClassificationCriteria,
  ): boolean {
    // If we don't have the demand text here, use criteria as proxy
    // Low keyword confidence indicators:
    // - Complexity is low (simple/vague query)
    // - Depth required is low (no specificity)
    // - Default category (technical) with low scores suggests poor match
    const isDefaultCategory = category === 'technical';
    const hasLowComplexity = criteria.complexity < 40;
    const hasLowDepth = criteria.depthRequired < 40;

    // If using default category with low specificity, likely low confidence
    if (isDefaultCategory && hasLowComplexity && hasLowDepth) {
      return true;
    }

    return false;
  }

  private calculatePersonalReadiness(
    demand: Demand,
    criteria: ClassificationCriteria,
  ): PersonalReadinessScore {
    const text = `${demand.title} ${demand.description}`.toLowerCase();
    const blockers: string[] = [];
    const nextQuestions: string[] = [];

    let score = 100;
    score -= Math.round(criteria.ambiguity * 0.3);
    score -= Math.round(criteria.interpretationRisk * 0.25);
    score -= Math.round(Math.max(0, criteria.complexity - 55) * 0.15);

    if (demand.description.trim().length < 80) {
      score -= 18;
      blockers.push('Descricao curta demais para gerar plano confiavel.');
      nextQuestions.push('Qual e o resultado concreto esperado quando isso estiver pronto?');
    }

    const hasUserOrActor = [
      'usuario',
      'user',
      'cliente',
      'admin',
      'builder',
      'eu ',
      'meu ',
      'minha ',
      'pessoa',
    ].some((term) => text.includes(term));
    if (!hasUserOrActor) {
      score -= 12;
      blockers.push('Usuario ou ator principal nao esta claro.');
      nextQuestions.push('Quem vai usar ou se beneficiar diretamente desta entrega?');
    }

    const hasOutcome = [
      'para ',
      'objetivo',
      'resultado',
      'beneficio',
      'resolver',
      'reduzir',
      'aumentar',
      'melhorar',
      'economizar',
    ].some((term) => text.includes(term));
    if (!hasOutcome) {
      score -= 12;
      blockers.push('Objetivo ou beneficio esperado nao esta explicito.');
      nextQuestions.push('Qual problema esta sendo resolvido e como voce vai saber que resolveu?');
    }

    const hasAcceptanceSignal = [
      'criterio',
      'aceite',
      'pronto',
      'deve',
      'quando',
      'validar',
      'testar',
      'medir',
    ].some((term) => text.includes(term));
    if (!hasAcceptanceSignal) {
      score -= 10;
      nextQuestions.push('Quais criterios tornam esta demanda pronta para considerar concluida?');
    }

    const hasScopeBoundary = [
      'nao',
      'fora de escopo',
      'apenas',
      'somente',
      'sem ',
      'limite',
      'restricao',
    ].some((term) => text.includes(term));
    if (!hasScopeBoundary && criteria.complexity > 60) {
      score -= 8;
      nextQuestions.push('O que explicitamente nao deve ser feito nesta primeira versao?');
    }

    score = Math.min(100, Math.max(0, score));

    const level: PersonalReadinessScore['level'] =
      score >= 75 ? 'ready' : score >= 45 ? 'needs_refinement' : 'blocked';

    const recommendation =
      level === 'ready'
        ? 'Pode gerar PRD e tasks enxutos para execucao.'
        : level === 'needs_refinement'
          ? 'Refine as perguntas principais antes de implementar.'
          : 'Nao implemente ainda; esclareca objetivo, usuario e criterio de aceite.';

    return {
      score,
      level,
      blockers,
      nextQuestions: nextQuestions.slice(0, 4),
      recommendation,
    };
  }

  private calculateProgressiveRefinement(
    demand: Demand,
    criteria: ClassificationCriteria,
  ): ProgressiveRefinementTriage {
    // Basic heuristic to classify impact, risk, and complexity from 0-100 to low/medium/high
    const complexityScore = criteria.complexity;
    const riskScore = criteria.interpretationRisk;

    // impact might be estimated by urgency + demand type
    let impactScore = criteria.urgency;
    if (demand.type === 'nova_funcionalidade') impactScore += 20;
    if (demand.type === 'bug' && demand.priority === 'critica') impactScore += 40;

    const toStr = (score: number) => (score > 70 ? 'high' : score > 40 ? 'medium' : 'low');

    const complexity = toStr(complexityScore) as 'high' | 'medium' | 'low';
    const risk = toStr(riskScore) as 'high' | 'medium' | 'low';
    const impact = toStr(impactScore) as 'high' | 'medium' | 'low';

    // Default to Level 1 (Rapid)
    let recommendedLevel: 1 | 2 | 3 = 1;

    // Level 3 (Complete) logic:
    if (complexity === 'high' || risk === 'high' || impact === 'high') {
      recommendedLevel = 3;
    }
    // Level 2 (Functional) logic:
    else if (complexity === 'medium' || risk === 'medium' || impact === 'medium') {
      recommendedLevel = 2;
    }

    return {
      recommendedLevel,
      impact,
      risk,
      complexity,
    };
  }

  /**
   * Generates classification notes
   * @param demand - The demand
   * @param criteria - Classification criteria
   * @param category - Determined category
   * @returns Classification notes
   */
  private generateClassificationNotes(
    demand: Demand,
    criteria: ClassificationCriteria,
    category: DemandCategory,
    personalReadiness: PersonalReadinessScore,
  ): string {
    const notes: string[] = [];

    notes.push(`Demand classified as: ${category}`);
    notes.push(`Confidence: ${this.calculateConfidence(demand, criteria, category)}%`);
    notes.push(`Personal readiness: ${personalReadiness.score}% (${personalReadiness.level})`);
    notes.push(`Recommendation: ${personalReadiness.recommendation}`);

    if (criteria.ambiguity > 60) {
      notes.push(`⚠️ High ambiguity detected (${criteria.ambiguity}%) - may require clarification`);
    }

    if (criteria.interpretationRisk > 60) {
      notes.push(
        `⚠️ High interpretation risk (${criteria.interpretationRisk}%) - ensure clear communication`,
      );
    }

    if (criteria.complexity > 70) {
      notes.push(
        `🔧 High complexity (${criteria.complexity}%) - consider breaking into smaller tasks`,
      );
    }

    if (criteria.depthRequired > 80) {
      notes.push(`📊 High depth required (${criteria.depthRequired}%) - detailed analysis needed`);
    }

    if (criteria.urgency > 80) {
      notes.push(`⏰ High urgency (${criteria.urgency}%) - prioritize accordingly`);
    }

    return notes.join('\n');
  }

  /**
   * Updates demand with classification information
   * @param demandId - Demand ID
   * @param classification - Classification result
   */
  async updateDemandWithClassification(
    demandId: number,
    classification: DemandClassification,
  ): Promise<void> {
    await demandRepository.update(demandId, {
      classification: {
        category: classification.category,
        criteria: classification.criteria,
        confidence: classification.confidence,
        recommendedAgents: classification.recommendedAgents,
        personalReadiness: classification.personalReadiness,
        progressiveRefinement: classification.progressiveRefinement,
        notes: classification.notes,
        classifiedAt: new Date().toISOString(),
      },
    });
  }

  /**
   * Spec 10126 T3: check if agent-router delegation is enabled.
   * Uses the demandClassifierUseAgentRouter feature flag (default false).
   */
  private isAgentRouterDelegationEnabled(): boolean {
    const flagsPath = resolvePath('config/feature-flags.json');
    try {
      if (fs.existsSync(flagsPath)) {
        const flags = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
        return flags.demandClassifierUseAgentRouter === true;
      }
      return false;
    } catch (error) {
      logger.error('Feature flag IO error — demandClassifierUseAgentRouter', {
        context: {
          component: 'demand-classifier',
          flag_path: flagsPath,
        },
        error,
      });
      return false;
    }
  }

  /**
   * Spec 10126 T3: delegate to agent-router.ts while preserving the
   * DemandClassification contract consumed by agent-orchestrator, routes and
   * downstream services. Non-router fields are filled with safe defaults.
   */
  private async classifyDemandViaRouter(demand: Demand): Promise<DemandClassification> {
    const startTime = Date.now();
    const availableAgents = Array.from(
      new Set(Object.values(DEMAND_TYPES).flatMap((config) => config.squad)),
    );

    const routerResult = await agentRouterService.classifyDemandForRouting(
      demand.title,
      demand.description,
      demand.type,
      availableAgents,
      demand.domain ?? 'padrao',
    );

    // Map SmartRouterClassification to the legacy DemandClassification shape.
    const demandCategory = this.toDemandCategory(routerResult.category);
    const recommendedAgents = routerResult.selectedAgents.length
      ? routerResult.selectedAgents
      : availableAgents;

    const confidence = Math.round(routerResult.confidence * 100);

    const criteria: ClassificationCriteria = {
      ambiguity: confidence < 60 ? 60 : 30,
      interpretationRisk: confidence < 60 ? 50 : 25,
      depthRequired: recommendedAgents.length > 5 ? 70 : 40,
      complexity: recommendedAgents.length > 6 ? 70 : 40,
      urgency: demand.priority === 'critica' ? 90 : demand.priority === 'alta' ? 70 : 40,
    };

    const personalReadiness: PersonalReadinessScore = {
      score: confidence,
      level: confidence >= 70 ? 'ready' : confidence >= 40 ? 'needs_refinement' : 'blocked',
      blockers: confidence < 40 ? ['Classificação incerta pelo agent-router'] : [],
      nextQuestions: [],
      recommendation:
        confidence >= 70
          ? 'Proceder com a execução da squad.'
          : 'Revisar escopo antes de iniciar a execução.',
    };

    const progressiveRefinement: ProgressiveRefinementTriage = {
      recommendedLevel: recommendedAgents.length <= 3 ? 1 : recommendedAgents.length <= 5 ? 2 : 3,
      impact:
        recommendedAgents.length > 5 ? 'high' : recommendedAgents.length > 3 ? 'medium' : 'low',
      risk: confidence >= 70 ? 'low' : confidence >= 40 ? 'medium' : 'high',
      complexity:
        recommendedAgents.length > 6 ? 'high' : recommendedAgents.length > 3 ? 'medium' : 'low',
    };

    const result: DemandClassification = {
      category: demandCategory,
      criteria,
      confidence,
      recommendedAgents,
      notes: routerResult.reasoning,
      personalReadiness,
      progressiveRefinement,
      routerContract: {
        tipo_demanda: this.toTipoDemanda(demand.type),
        complexidade:
          recommendedAgents.length > 6 ? 'alta' : recommendedAgents.length > 3 ? 'media' : 'baixa',
        risco: confidence >= 70 ? 'baixo' : confidence >= 40 ? 'medio' : 'alto',
        clareza_da_demanda: confidence >= 70 ? 'alta' : confidence >= 40 ? 'media' : 'baixa',
        impacto_negocio:
          demand.priority === 'critica' ? 'critico' : demand.priority === 'alta' ? 'alto' : 'medio',
        necessita_codigo:
          recommendedAgents.includes('tech_lead') || recommendedAgents.includes('developer'),
        necessita_arquitetura: recommendedAgents.includes('architect'),
        necessita_ux: recommendedAgents.includes('ux_designer'),
        necessita_qa: recommendedAgents.includes('qa'),
        necessita_prd:
          recommendedAgents.includes('product_owner') ||
          recommendedAgents.includes('product_manager'),
        necessita_dados: recommendedAgents.includes('data_analyst'),
        modelo_recomendado: 'agent-router',
        agentes_recomendados: recommendedAgents,
        justificativa: routerResult.reasoning,
      },
    };

    logger.info('Demand classified via agent-router', {
      context: {
        demandId: demand.id,
        step: 'classify_demand_via_router',
        category: result.category,
        confidence,
        agents: recommendedAgents.join(','),
        routerMethod: routerResult.method,
        durationMs: Date.now() - startTime,
      },
    });

    eventBus.publish('DEMAND_ANALYSIS_COMPLETED', {
      demandId: demand.id,
      classification: result,
      timestamp: new Date().toISOString(),
    });

    return result;
  }

  /**
   * Map demand.type to RouterClassificationContract.tipo_demanda.
   */
  private toTipoDemanda(type: string): RouterClassificationContract['tipo_demanda'] {
    const mapping: Record<string, RouterClassificationContract['tipo_demanda']> = {
      bug: 'bug',
      nova_funcionalidade: 'feature',
      melhoria: 'melhoria',
      discovery: 'discovery',
      debito_tecnico: 'debito_tecnico',
      refactoring: 'refactoring',
      security: 'security',
      infraestrutura: 'infraestrutura',
      documentacao: 'documentacao',
      analise_tecnica: 'analise_tecnica',
      spike: 'spike',
    };
    return mapping[type] ?? 'feature';
  }

  /**
   * Map agent-router category strings to legacy DemandCategory.
   */
  private toDemandCategory(category: string): DemandCategory {
    const known: Record<string, DemandCategory> = {
      technical: 'technical',
      business: 'business',
      analytical: 'analytical',
      creative: 'creative',
      legal: 'legal',
      support: 'support',
      research: 'research',
      mixed: 'business',
      unknown: 'business',
    };
    return known[category] ?? 'business';
  }
}

// Create a singleton instance
export const demandClassifier = new DemandClassifier();
