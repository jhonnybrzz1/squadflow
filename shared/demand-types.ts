import { z } from 'zod';
import { AgentRole } from './agent-roles';

export type DemandRegistryCategory =
  | 'technical'
  | 'legal'
  | 'creative'
  | 'business'
  | 'analytical'
  | 'support'
  | 'research'
  | 'regulatory'
  | 'product'
  | 'mixed';

export interface DemandTypeConstraints {
  maxTechnicalDepth: 'low' | 'medium' | 'high';
  maxScope: 'narrow' | 'medium' | 'broad';
  requireAppSecReview: boolean;
  maxRounds: number;
  defaultRefinementLevel: 1 | 2 | 3;
}

export interface DemandTypeRoutingConfig {
  category: DemandRegistryCategory;
  squad: readonly AgentRole[];
  constraints: DemandTypeConstraints;
  keywords: readonly string[];
  regex: readonly string[];
  /** Demanda 10111: definição curta para o Contrato Inteligente de Início. */
  description?: string;
  /** Demanda 10111: 1-2 exemplos de input para o contrato. */
  examples?: readonly string[];
  routingPatterns?: Partial<Record<DemandRegistryCategory, readonly string[]>>;
  agentOverrides?: {
    include?: readonly string[];
  };
}

export const DEMAND_TYPES = {
  nova_funcionalidade: {
    label: 'NOVA FEATURE',
    shortLabel: 'FEATURE',
    icon: 'Plus',
    color: 'cyan',
    suggestedPriority: 'media',
    prdTemplate: 'feature',
    refinementLevel: 4,
    intensity: 'alta',
    defaultTeam: 'Development Team',
    defaultResolutionMinutes: 2880, // 48h
    complexityAdjustment: 15,
    baseSuccessRate: 85,
    canonicalDemandType: 'newFeature',
    outputType: 'feature_prd',
    typeRequirements: ['User stories', 'Acceptance criteria', 'Success metrics'],
    maxEffortDays: 21, // Flexibilizado de 14 para 21
    minROI: '2:1', // Flexibilizado de 3:1 para 2:1
    primaryFramework: 'jtbd',
    secondaryFrameworks: ['double-diamond', 'heart'],
    resolutionMultiplier: 1.5,
    classifierScoreAdjustments: {
      technical: 15,
      creative: 10,
      business: 5,
    },
    category: 'business',
    squad: [
      AgentRole.product_owner,
      AgentRole.product_manager,
      AgentRole.ux,
      AgentRole.tech_lead,
      AgentRole.qa,
    ],
    constraints: {
      maxTechnicalDepth: 'high',
      maxScope: 'broad',
      requireAppSecReview: false,
      maxRounds: 3,
      defaultRefinementLevel: 3,
    },
    keywords: ['feature', 'funcionalidade', 'produto', 'usuário', 'mvp', 'roadmap'],
    description: 'Valor novo que ainda não existe no produto.',
    examples: ['Criar dashboard de métricas', 'Adicionar login com Google'],
    regex: [
      '\\b(funcionalidade|feature|produto|product|cliente|usuário|user|jornada|história|story|épico|epic|roadmap|backlog|sprint|mvp)\\b',
    ],
    routingPatterns: {
      business: [
        '\\b(negócio|business|receita|revenue|estratégia|strategy|market|vendas|sales|roi|kpi|stakeholder|growth|conversão|churn)\\b',
      ],
    },
  },
  melhoria: {
    label: 'MELHORIA',
    shortLabel: 'UPGRADE',
    icon: 'TrendingUp',
    color: 'lime',
    suggestedPriority: 'media',
    prdTemplate: 'improvement',
    refinementLevel: 3,
    intensity: 'media',
    defaultTeam: 'Maintenance Team',
    defaultResolutionMinutes: 1440, // 24h
    complexityAdjustment: 5,
    baseSuccessRate: 90,
    canonicalDemandType: 'improvement',
    outputType: 'improvement_plan',
    typeRequirements: [
      'Current baseline',
      'Expected improvement',
      'Before and after metrics',
      'Compatibility check',
    ],
    maxEffortDays: 7,
    minROI: '3:1',
    primaryFramework: 'heart',
    secondaryFrameworks: ['jtbd', 'crisp-dm'],
    resolutionMultiplier: 1.0,
    classifierScoreAdjustments: {
      technical: 5,
      creative: 5,
      analytical: 5,
    },
    category: 'technical',
    squad: [AgentRole.product_owner, AgentRole.tech_lead, AgentRole.qa, AgentRole.product_manager],
    constraints: {
      maxTechnicalDepth: 'medium',
      maxScope: 'medium',
      requireAppSecReview: false,
      maxRounds: 3,
      defaultRefinementLevel: 3,
    },
    keywords: ['melhoria', 'otimizar', 'performance', 'evolução', 'upgrade'],
    description: 'Melhoria em funcionalidade ou performance já existente.',
    examples: ['Melhorar velocidade do filtro', 'Ajustar layout do formulário'],
    regex: ['\\b(otimizar|performance|evolução|upgrade|aprimorar)\\b'],
    routingPatterns: {
      creative: [
        '\\b(design|ux|ui|protótipo|mockup|wireframe|usabilidade|visual|layout|interface|figma|componente visual|acessibilidade)\\b',
      ],
    },
  },
  bug: {
    label: 'BUG FIX',
    shortLabel: 'BUG',
    icon: 'Bug',
    color: 'magenta',
    suggestedPriority: 'alta',
    prdTemplate: 'bug',
    refinementLevel: 2,
    intensity: 'baixa',
    defaultTeam: 'Support Team',
    defaultResolutionMinutes: 480, // 8h
    complexityAdjustment: 10,
    baseSuccessRate: 95,
    canonicalDemandType: 'bug',
    outputType: 'bug_fix_plan',
    typeRequirements: [
      'Root cause analysis',
      'Steps to reproduce',
      'Regression tests',
      'Fix validation',
    ],
    maxEffortDays: 3,
    minROI: 'N/A',
    primaryFramework: 'severity-priority',
    secondaryFrameworks: ['jtbd', 'heart'],
    resolutionMultiplier: 0.5,
    classifierScoreAdjustments: {
      support: 20,
      technical: 10,
    },
    category: 'technical',
    squad: [AgentRole.product_owner, AgentRole.qa, AgentRole.tech_lead],
    constraints: {
      maxTechnicalDepth: 'medium',
      maxScope: 'narrow',
      requireAppSecReview: false,
      maxRounds: 3,
      defaultRefinementLevel: 2,
    },
    keywords: ['bug', 'erro', 'falha', 'crash', 'hotfix', 'rollback'],
    regex: ['\\b(bug|erro|falha|crash|hotfix|rollback|incidente|produção caiu|downtime)\\b'],
    routingPatterns: {
      support: [
        '\\b(suporte|support|ticket|incidente|hotfix|urgent|emergência|produção caiu|downtime|rollback)\\b',
      ],
    },
  },
  discovery: {
    label: 'DISCOVERY',
    shortLabel: 'DISC',
    icon: 'Compass',
    color: 'violet',
    suggestedPriority: 'baixa',
    prdTemplate: 'discovery',
    refinementLevel: 3,
    intensity: 'media',
    defaultTeam: 'Product Team',
    defaultResolutionMinutes: 1440, // 24h
    complexityAdjustment: 0,
    baseSuccessRate: 80,
    canonicalDemandType: 'discovery',
    outputType: 'research_report',
    typeRequirements: ['Hypothesis', 'Research questions', 'Validation criteria'],
    maxEffortDays: 10, // Flexibilizado de 5 para 10
    minROI: 'Learning or insight', // Flexibilizado
    primaryFramework: 'double-diamond',
    secondaryFrameworks: ['jtbd', 'heart'],
    resolutionMultiplier: 1.0,
    classifierScoreAdjustments: {
      research: 20,
      creative: 10,
    },
    category: 'research',
    squad: [AgentRole.product_owner, AgentRole.product_manager, AgentRole.analista_de_dados],
    constraints: {
      maxTechnicalDepth: 'low',
      maxScope: 'medium',
      requireAppSecReview: false,
      maxRounds: 3,
      defaultRefinementLevel: 3,
    },
    keywords: ['discovery', 'pesquisa', 'hipótese', 'experimento', 'benchmark'],
    regex: [
      '\\b(pesquisa|research|explorar|discovery|hipótese|experiment|survey|benchmark|poc|spike)\\b',
    ],
  },
  // Demanda 10111: novo tipo REVISAO para validar entregas.
  revisao: {
    label: 'REVISÃO',
    shortLabel: 'REV',
    icon: 'CheckCircle',
    color: 'teal',
    suggestedPriority: 'alta',
    prdTemplate: 'review',
    refinementLevel: 2,
    intensity: 'baixa',
    defaultTeam: 'QA Team',
    defaultResolutionMinutes: 480, // 8h
    complexityAdjustment: 0,
    baseSuccessRate: 95,
    canonicalDemandType: 'review',
    outputType: 'review_report',
    typeRequirements: ['Original demand reference', 'Acceptance criteria', 'Review result'],
    maxEffortDays: 2,
    minROI: 'N/A',
    primaryFramework: 'severity-priority',
    secondaryFrameworks: ['checklist'],
    resolutionMultiplier: 0.5,
    classifierScoreAdjustments: {
      support: 20,
      technical: 5,
    },
    category: 'support',
    squad: [AgentRole.product_owner, AgentRole.qa, AgentRole.tech_lead],
    constraints: {
      maxTechnicalDepth: 'low',
      maxScope: 'narrow',
      requireAppSecReview: false,
      maxRounds: 2,
      defaultRefinementLevel: 2,
    },
    keywords: ['revisão', 'validar', 'verificar', 'conferir', 'checar entrega', 'aceite'],
    description: 'Validar se uma entrega foi construída conforme spec.',
    examples: ['Revisar se demanda X foi entregue corretamente', 'Conferir aceite do checkout'],
    regex: [
      '\\b(revisar|revisão|validar|verificar|conferir|checar entrega|checagem|aceitação|aceite|foi entregue|entregue corretamente)\\b',
    ],
  },
  analise_exploratoria: {
    label: 'ANÁLISE',
    shortLabel: 'DATA',
    icon: 'BarChart',
    color: 'orange',
    suggestedPriority: 'baixa',
    prdTemplate: 'analysis',
    refinementLevel: 3,
    intensity: 'media',
    defaultTeam: 'Data Team',
    defaultResolutionMinutes: 1440, // 24h
    complexityAdjustment: 0,
    baseSuccessRate: 85,
    canonicalDemandType: 'exploratoryAnalysis',
    outputType: 'analysis_report',
    typeRequirements: [
      'Data sources',
      'Current baseline',
      'Analysis approach',
      'Insights',
      'Recommendations',
    ],
    maxEffortDays: 5,
    minROI: 'Actionable insight',
    primaryFramework: 'crisp-dm',
    secondaryFrameworks: ['double-diamond', 'jtbd'],
    resolutionMultiplier: 1.0,
    classifierScoreAdjustments: {
      analytical: 20,
      research: 10,
    },
    category: 'analytical',
    squad: [AgentRole.product_owner, AgentRole.analista_de_dados, AgentRole.product_manager],
    constraints: {
      maxTechnicalDepth: 'medium',
      maxScope: 'medium',
      requireAppSecReview: false,
      maxRounds: 3,
      defaultRefinementLevel: 3,
    },
    keywords: ['dados', 'análise', 'relatório', 'dashboard', 'kpi', 'analytics'],
    description: 'Investigar, avaliar ou decidir sobre viabilidade.',
    examples: ['Avaliar viabilidade de cache', 'Analisar churn de usuários'],
    regex: [
      '\\b(dados|data|análise|report|relatório|métrica|dashboard|analytics|insight|tendência|forecast|bi|etl|kpi)\\b',
    ],
  },
  security: {
    label: 'SEGURANÇA',
    shortLabel: 'SEC',
    icon: 'ShieldAlert',
    color: '#e11d48',
    suggestedPriority: 'alta',
    prdTemplate: 'security',
    refinementLevel: 4,
    intensity: 'alta',
    defaultTeam: 'Security Team',
    // Defaults operacionais herdados de nova_funcionalidade; não são baseline medido.
    defaultResolutionMinutes: 2880,
    complexityAdjustment: 15,
    baseSuccessRate: 85,
    canonicalDemandType: 'security',
    outputType: 'security_assessment',
    typeRequirements: [
      'Seção Segurança, Compliance e Riscos de Dados',
      'Threat and vulnerability assessment',
      'LGPD and compliance impact',
      'Data risks and mitigations with validation criteria',
    ],
    maxEffortDays: 5,
    minROI: 'Actionable insight',
    primaryFramework: 'threat-modeling',
    secondaryFrameworks: ['severity-priority', 'privacy-by-design'],
    resolutionMultiplier: 1.5,
    measurementStatus: 'A MEDIR — sem baseline',
    configurationBasis: 'inherited:nova_funcionalidade',
    classifierScoreAdjustments: {
      technical: 20,
      legal: 20,
      support: 5,
    },
    category: 'legal',
    squad: [
      AgentRole.product_owner,
      AgentRole.security_specialist,
      AgentRole.tech_lead,
      AgentRole.qa,
    ],
    constraints: {
      maxTechnicalDepth: 'high',
      maxScope: 'medium',
      requireAppSecReview: true,
      maxRounds: 3,
      defaultRefinementLevel: 3,
    },
    keywords: ['segurança', 'security', 'lgpd', 'vulnerabilidade', 'compliance', 'privacidade'],
    regex: [
      '\\b(segurança|security|lgpd|vulnerabilidade|compliance|privacidade|threat|risco de dados|dados pessoais)\\b',
    ],
    agentOverrides: {
      include: [AgentRole.security_specialist],
    },
  },
  refactoring: {
    label: 'REFACTORING',
    shortLabel: 'REFACTOR',
    icon: 'Wrench',
    color: '#64748b',
    suggestedPriority: 'media',
    prdTemplate: 'refactoring',
    refinementLevel: 3,
    intensity: 'media',
    defaultTeam: 'Development Team',
    defaultResolutionMinutes: 1440,
    // Defaults operacionais herdados de melhoria; não são baseline medido.
    complexityAdjustment: 5,
    baseSuccessRate: 90,
    canonicalDemandType: 'refactoring',
    outputType: 'refactoring_plan',
    typeRequirements: [
      'Current design and technical debt',
      'Target design',
      'Preserved behavior',
      'Regression tests and rollback',
    ],
    maxEffortDays: 5,
    minROI: 'Actionable insight',
    primaryFramework: 'incremental-refactoring',
    secondaryFrameworks: ['severity-priority'],
    resolutionMultiplier: 1.0,
    measurementStatus: 'A MEDIR — sem baseline',
    configurationBasis: 'inherited:melhoria',
    classifierScoreAdjustments: {
      technical: 20,
      analytical: 5,
    },
    category: 'technical',
    squad: [AgentRole.product_owner, AgentRole.tech_lead, AgentRole.qa, AgentRole.architect],
    constraints: {
      maxTechnicalDepth: 'high',
      maxScope: 'medium',
      requireAppSecReview: false,
      maxRounds: 3,
      defaultRefinementLevel: 3,
    },
    keywords: ['refactoring', 'refatoração', 'débito técnico', 'arquitetura', 'design atual'],
    regex: [
      '\\b(refactor|refactoring|refatoração|refatorar|débito técnico|tech debt|design atual|target design)\\b',
    ],
    agentOverrides: {
      include: [AgentRole.architect],
    },
  },
  infraestrutura: {
    label: 'INFRAESTRUTURA',
    shortLabel: 'INFRA',
    icon: 'Cloud',
    color: '#6366f1',
    suggestedPriority: 'alta',
    prdTemplate: 'infrastructure',
    refinementLevel: 4,
    intensity: 'alta',
    defaultTeam: 'Platform Team',
    // Defaults operacionais herdados de security; não são baseline medido.
    defaultResolutionMinutes: 2880,
    complexityAdjustment: 15,
    baseSuccessRate: 85,
    canonicalDemandType: 'infrastructure',
    outputType: 'infrastructure_plan',
    typeRequirements: [
      'Current architecture and constraints',
      'Target architecture and trade-offs',
      'Security, observability and capacity risks',
      'Migration, validation and rollback plan',
    ],
    maxEffortDays: 5,
    minROI: 'Actionable insight',
    primaryFramework: 'architecture-decision-record',
    secondaryFrameworks: ['threat-modeling', 'incremental-refactoring'],
    resolutionMultiplier: 1.5,
    measurementStatus: 'A MEDIR — sem baseline',
    configurationBasis: 'inherited:security',
    classifierScoreAdjustments: {
      technical: 25,
      support: 5,
    },
    category: 'technical',
    squad: [
      AgentRole.product_owner,
      AgentRole.architect,
      AgentRole.tech_lead,
      AgentRole.qa,
      AgentRole.security_specialist,
    ],
    constraints: {
      maxTechnicalDepth: 'high',
      maxScope: 'broad',
      requireAppSecReview: true,
      maxRounds: 3,
      defaultRefinementLevel: 3,
    },
    keywords: ['infraestrutura', 'cloud', 'deploy', 'observabilidade', 'kubernetes', 'ci/cd'],
    regex: [
      '\\b(infra|infraestrutura|cloud|deploy|observabilidade|kubernetes|k8s|docker|container|ci\\/cd|pipeline|rollback)\\b',
    ],
    agentOverrides: {
      include: [AgentRole.architect, AgentRole.security_specialist],
    },
  },
} as const satisfies Record<string, DemandTypeRoutingConfig & Record<string, unknown>>;

/** Reservado para tipos anunciados, mas ainda não aceitos pelo schema. */
export const PLANNED_DEMAND_TYPES = {} as const;

// Spec 10192: demandTypeSchema derivado canonicamente das keys de DEMAND_TYPES
// para eliminar duplicação de contratos. Atualiza automaticamente quando novos
// tipos são adicionados a DEMAND_TYPES.
export type DemandType = keyof typeof DEMAND_TYPES;
const DEMAND_TYPE_KEYS = Object.keys(DEMAND_TYPES) as [DemandType, ...DemandType[]];
export const demandTypeSchema = z.enum(DEMAND_TYPE_KEYS);

export function getDemandTypeConfig(type: string) {
  const config = DEMAND_TYPES[type as DemandType];
  if (!config) {
    return DEMAND_TYPES.discovery;
  }
  return config;
}

export function getDemandTypeRoutingConfig(type: string): DemandTypeRoutingConfig {
  return getDemandTypeConfig(type);
}

export function isDemandType(type: string): type is DemandType {
  return type in DEMAND_TYPES;
}

export const PRIORITIES = {
  baixa: { label: 'Baixa', color: 'slate' },
  media: { label: 'Média', color: 'blue' },
  alta: { label: 'Alta', color: 'amber' },
  critica: { label: 'Crítica', color: 'red' },
} as const;

export const prioritySchema = z.enum(['baixa', 'media', 'alta', 'critica']);
export type DemandPriority = z.infer<typeof prioritySchema>;
