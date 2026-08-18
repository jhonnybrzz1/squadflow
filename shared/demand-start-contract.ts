import { DEMAND_TYPES, type DemandType } from './demand-types';

export type DemandReadinessStatus =
  | 'ready_for_development'
  | 'needs_discovery'
  | 'needs_hypothesis_validation'
  | 'needs_data'
  | 'needs_data_baseline'
  | 'needs_reproduction'
  | 'needs_scope_breakdown';

export type DemandContractField = {
  id: string;
  label: string;
  placeholder: string;
  description?: string;
  required: boolean;
};

export type DemandContractFields = Record<string, string>;

export type DemandStartContract = {
  fields: DemandContractField[];
  incompleteStatus: DemandReadinessStatus;
  incompleteNextStep: string;
};

export type DemandTypeSuggestion = {
  type: DemandType;
  label: string;
  confidence: number;
  reason: string;
};

export const CLASSIFIER_FALLBACK_THRESHOLD = 0.7;

export type DemandTypeClassification = {
  suggestedType: DemandType;
  confidence: number;
  fallback: boolean;
  matchedSignals: string[];
};

export type DemandReadinessResult = {
  score: number;
  status: DemandReadinessStatus;
  statusLabel: string;
  isComplete: boolean;
  canSubmit: boolean;
  missingFields: DemandContractField[];
  completedFields: DemandContractField[];
  nextStep: string;
  suggestedType?: DemandTypeSuggestion;
  classification?: DemandTypeClassification;
};

export const READINESS_STATUS_LABELS: Record<DemandReadinessStatus, string> = {
  ready_for_development: 'Pronto para desenvolvimento',
  needs_discovery: 'Precisa discovery',
  needs_hypothesis_validation: 'Precisa validar hipótese',
  needs_data: 'Precisa dados',
  needs_data_baseline: 'Precisa baseline de dados',
  needs_reproduction: 'Precisa reprodução',
  needs_scope_breakdown: 'Precisa quebrar escopo',
};

export const DEMAND_START_CONTRACTS: Record<DemandType, DemandStartContract> = {
  nova_funcionalidade: {
    incompleteStatus: 'needs_discovery',
    incompleteNextStep:
      'Complete usuário, problema, job story, métrica e rollout antes de iniciar a feature.',
    fields: [
      {
        id: 'feature_user',
        label: 'Usuário',
        placeholder: 'Quem sente o problema ou usará a feature',
        description: 'Persona ou perfil do usuário afetado pela funcionalidade.',
        required: true,
      },
      {
        id: 'feature_problem',
        label: 'Problema',
        placeholder: 'Qual problema real a feature resolve',
        description: 'Descreva a dor ou necessidade que a funcionalidade vai resolver.',
        required: true,
      },
      {
        id: 'feature_job_story',
        label: 'Job story',
        placeholder: 'Quando..., quero..., para...',
        description: 'Formato: "Quando [situação], quero [ação], para [objetivo]".',
        required: true,
      },
      {
        id: 'feature_success_metric',
        label: 'Métrica',
        placeholder: 'Como saberemos que funcionou',
        description: 'Indicador mensurável de sucesso (ex: taxa de conversão, tempo de resposta).',
        required: true,
      },
      {
        id: 'feature_rollout',
        label: 'Rollout',
        placeholder: 'Como lançar sem risco desnecessário',
        description: 'Estratégia de lançamento: feature flag, beta, rollout gradual, etc.',
        required: true,
      },
    ],
  },
  melhoria: {
    incompleteStatus: 'needs_data',
    incompleteNextStep:
      'Informe métrica alvo, restrições e compatibilidade. Se não houver baseline, registre "A MEDIR — sem baseline" e defina a meta relativa após a coleta.',
    fields: [
      {
        id: 'improvement_baseline',
        label: 'Baseline atual',
        placeholder: 'Estado atual ou medição antes da mudança',
        description: 'Valor ou comportamento atual que será melhorado.',
        required: false,
      },
      {
        id: 'improvement_target_metric',
        label: 'Métrica alvo',
        placeholder: 'Resultado esperado depois da melhoria',
        description: 'Valor ou comportamento esperado após a melhoria.',
        required: true,
      },
      {
        id: 'improvement_constraints',
        label: 'Restrições',
        placeholder: 'Limites técnicos, UX, prazo ou compatibilidade',
        description: 'Limitações que devem ser respeitadas na implementação.',
        required: true,
      },
      {
        id: 'improvement_compatibility',
        label: 'Compatibilidade',
        placeholder: 'O que não pode quebrar ou regredir',
        description: 'Funcionalidades ou comportamentos que devem ser preservados.',
        required: true,
      },
    ],
  },
  bug: {
    incompleteStatus: 'needs_reproduction',
    incompleteNextStep:
      'Inclua passos de reprodução, esperado vs ocorrido, ambiente e severidade antes de abrir o bug.',
    fields: [
      {
        id: 'bug_reproduction_steps',
        label: 'Passos de reprodução',
        placeholder: 'Passo 1, passo 2, resultado observado',
        description: 'Sequência de ações para reproduzir o bug consistentemente.',
        required: true,
      },
      {
        id: 'bug_expected_actual',
        label: 'Esperado vs ocorrido',
        placeholder: 'O que deveria acontecer e o que aconteceu',
        description: 'Compare comportamento esperado com o observado.',
        required: true,
      },
      {
        id: 'bug_environment',
        label: 'Ambiente',
        placeholder: 'Browser, dispositivo, versão, endpoint ou contexto',
        description: 'Detalhes do ambiente onde o bug foi observado.',
        required: true,
      },
      {
        id: 'bug_severity',
        label: 'Severidade',
        placeholder: 'Crítica, alta, média ou baixa com impacto',
        description:
          'Nível de impacto: crítica bloqueia, alta afeta muitos, média/baixa são contornáveis.',
        required: true,
      },
    ],
  },
  discovery: {
    incompleteStatus: 'needs_hypothesis_validation',
    incompleteNextStep:
      'Defina hipótese, evidência, amostragem e critério de validação para garantir uma pesquisa baseada em fatos.',
    fields: [
      {
        id: 'discovery_hypothesis',
        label: 'Hipótese',
        placeholder: 'O que precisa ser validado ou invalidado',
        required: true,
      },
      {
        id: 'discovery_observed_evidence',
        label: 'Evidência observada',
        placeholder: 'Fatos ou observações que sugerem este problema',
        required: true,
      },
      {
        id: 'discovery_user_count',
        label: 'Amostragem',
        placeholder: 'Número de usuários ou casos observados',
        required: true,
      },
      {
        id: 'discovery_questions',
        label: 'Perguntas',
        placeholder: 'Perguntas que a pesquisa deve responder',
        required: true,
      },
      {
        id: 'discovery_method',
        label: 'Método',
        placeholder: 'Entrevistas, teste de protótipo, análise desk, survey',
        required: true,
      },
      {
        id: 'discovery_validation_criteria',
        label: 'Critério de validação',
        placeholder: 'O que define se a hipótese foi validada ou invalidada',
        required: true,
      },
    ],
  },
  analise_exploratoria: {
    incompleteStatus: 'needs_data_baseline',
    incompleteNextStep:
      'Informe fonte de dados, baseline, pergunta analítica e decisão esperada antes de executar análise.',
    fields: [
      {
        id: 'analysis_data_source',
        label: 'Fonte de dados',
        placeholder: 'Tabela, arquivo, API, evento ou origem dos dados',
        required: true,
      },
      {
        id: 'analysis_baseline',
        label: 'Baseline/Comparador',
        placeholder: 'Valor atual ou cenário de referência para comparação',
        required: true,
      },
      {
        id: 'analysis_question',
        label: 'Pergunta analítica',
        placeholder: 'Pergunta que a análise precisa responder',
        required: true,
      },
      {
        id: 'analysis_period',
        label: 'Período',
        placeholder: 'Intervalo temporal ou recorte analisado',
        required: true,
      },
      {
        id: 'analysis_expected_decision',
        label: 'Decisão esperada',
        placeholder: 'Qual decisão será tomada com os insights',
        required: true,
      },
    ],
  },
  security: {
    incompleteStatus: 'needs_scope_breakdown',
    incompleteNextStep:
      'Informe ativos e dados afetados, ameaça, requisito regulatório e critérios de mitigação.',
    fields: [
      {
        id: 'security_assets_data',
        label: 'Ativos e dados afetados',
        placeholder: 'Dados pessoais, credenciais, API, serviço ou componente',
        required: true,
      },
      {
        id: 'security_threat',
        label: 'Ameaça ou vulnerabilidade',
        placeholder: 'Risco, vetor de ataque ou falha observada',
        required: true,
      },
      {
        id: 'security_compliance',
        label: 'Compliance',
        placeholder: 'LGPD, política ou obrigação aplicável',
        required: true,
      },
      {
        id: 'security_validation',
        label: 'Validação da mitigação',
        placeholder: 'Como provar que o risco foi reduzido',
        required: true,
      },
    ],
  },
  refactoring: {
    incompleteStatus: 'needs_scope_breakdown',
    incompleteNextStep:
      'Defina dívida atual, comportamento preservado, desenho alvo e estratégia de regressão/rollback.',
    fields: [
      {
        id: 'refactoring_current_debt',
        label: 'Dívida atual',
        placeholder: 'Problema estrutural verificável no código atual',
        required: true,
      },
      {
        id: 'refactoring_preserved_behavior',
        label: 'Comportamento preservado',
        placeholder: 'O que não pode mudar para o usuário ou integrações',
        required: true,
      },
      {
        id: 'refactoring_target_design',
        label: 'Desenho alvo',
        placeholder: 'Estrutura desejada após a refatoração',
        required: true,
      },
      {
        id: 'refactoring_regression',
        label: 'Regressão e rollback',
        placeholder: 'Testes e caminho seguro de reversão',
        required: true,
      },
    ],
  },
  infraestrutura: {
    incompleteStatus: 'needs_scope_breakdown',
    incompleteNextStep:
      'Defina estado atual, restrições, arquitetura alvo e plano de migração/rollback.',
    fields: [
      {
        id: 'infrastructure_current_state',
        label: 'Estado atual',
        placeholder: 'Cloud, serviços, dependências e gargalos atuais',
        required: true,
      },
      {
        id: 'infrastructure_constraints',
        label: 'Restrições',
        placeholder: 'Compatibilidade, segurança, operação e limites conhecidos',
        required: true,
      },
      {
        id: 'infrastructure_target',
        label: 'Arquitetura alvo',
        placeholder: 'Resultado técnico esperado e trade-offs',
        required: true,
      },
      {
        id: 'infrastructure_migration',
        label: 'Migração e rollback',
        placeholder: 'Como validar, implantar e reverter com segurança',
        required: true,
      },
    ],
  },
  // Demanda 10111: template enxuto de revisão (QA).
  revisao: {
    incompleteStatus: 'needs_reproduction',
    incompleteNextStep:
      'Informe a demanda original, o critério de aceite e o resultado da revisão (aprovado/rejeitado).',
    fields: [
      {
        id: 'review_original_demand',
        label: 'Demanda original',
        placeholder: 'ID ou link da demanda que foi entregue',
        description: 'Referência rastreável da entrega que será revisada.',
        required: true,
      },
      {
        id: 'review_acceptance_criteria',
        label: 'Critério de aceite',
        placeholder: 'O que deveria ter sido entregue para aprovar',
        description: 'Liste os critérios objetivos usados na revisão.',
        required: true,
      },
      {
        id: 'review_result',
        label: 'Resultado',
        placeholder: 'aprovado / rejeitado + observação',
        description: 'Veredito da revisão com breve justificativa.',
        required: true,
      },
    ],
  },
};

const TYPE_SIGNALS: Record<DemandType, string[]> = {
  // Demanda 10111: 4 famílias principais com sinais claros e pouca sobreposição.
  nova_funcionalidade: [
    'criar',
    'novo',
    'adicionar',
    'implementar',
    'construir',
    'desenvolver',
    'nova feature',
    'nova funcionalidade',
    'permitir',
    'suporte a',
    'dashboard',
  ],
  melhoria: [
    'melhorar',
    'ajustar',
    'otimizar',
    'refatorar',
    'corrigir',
    'reduzir',
    'acelerar',
    'melhoria',
    'otimizacao',
    'otimização',
    'performance',
    'lento',
    'refinar',
    'velocidade',
  ],
  bug: [
    'bug',
    'erro',
    'error',
    'falha',
    'crash',
    'quebra',
    'travando',
    'não funciona',
    'nao funciona',
    '500',
    'exception',
  ],
  discovery: ['pesquisa', 'entrevista', 'descoberta', 'hipotese', 'hipótese', 'pesquisa de campo'],
  revisao: [
    'revisar',
    'validar',
    'verificar',
    'conferir',
    'checar entrega',
    'checagem',
    'aceitacao',
    'aceitação',
    'aceite',
    'foi entregue',
    'entregue corretamente',
  ],
  analise_exploratoria: [
    'analisar',
    'avaliar',
    'investigar',
    'estudar',
    'pesquisar',
    'viabilidade',
    'análise',
    'analise',
    'dataset',
    'fonte de dados',
    'csv',
    'relatorio',
    'relatório',
    'tendencia',
    'tendência',
    'padrao',
    'padrão',
    'correlacao',
    'correlação',
    'base de dados',
  ],
  security: [
    'lgpd',
    'vulnerabilidade',
    'vulnerability',
    'seguranca',
    'security',
    'compliance',
    'protecao de dados',
    'dados pessoais',
    'criptografia',
    'autenticacao',
    'autorizacao',
    'ataque',
    'ameaca',
    'privacy',
    'privacidade',
  ],
  refactoring: [
    'refatorar',
    'refatoracao',
    'refactoring',
    'divida tecnica',
    'debito tecnico',
    'codigo legado',
    'legacy code',
    'acoplamento',
    'desacoplar',
    'reestruturar codigo',
    'code smell',
  ],
  infraestrutura: [
    'infraestrutura',
    'infrastructure',
    'cloud',
    'kubernetes',
    'docker',
    'deploy',
    'deployment',
    'terraform',
    'observabilidade',
    'escalabilidade',
    'load balancer',
    'pipeline ci',
    'pipeline cd',
  ],
};

function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isFilled(value: string | undefined): boolean {
  return Boolean(value && value.trim().length >= 3);
}

function hasBroadScope(text: string): boolean {
  const normalized = normalizeText(text);
  return [
    'sistema inteiro',
    'tudo',
    'toda a plataforma',
    'reescrever',
    'refazer inteiro',
    'do zero',
  ].some((signal) => normalized.includes(signal));
}

export function getDemandStartContract(type: DemandType): DemandStartContract {
  const contract = DEMAND_START_CONTRACTS[type];
  if (!contract) {
    // Fallback to discovery contract when type is not found
    return DEMAND_START_CONTRACTS.discovery;
  }
  return contract;
}

export function detectSuggestedDemandType(input: {
  selectedType: DemandType;
  title?: string;
  description?: string;
}): DemandTypeSuggestion | undefined {
  const classification = classifyDemandTypeF1(input);
  if (classification.fallback || classification.suggestedType === input.selectedType) {
    return undefined;
  }

  return {
    type: classification.suggestedType,
    label: DEMAND_TYPES[classification.suggestedType].label,
    confidence: Math.round(classification.confidence * 100),
    reason: `A descrição tem sinais fortes de ${DEMAND_TYPES[classification.suggestedType].label}.`,
  };
}

export function classifyDemandTypeF1(
  input: { title?: string; description?: string },
  options: { threshold?: number } = {},
): DemandTypeClassification {
  const text = normalizeText(`${input.title || ''} ${input.description || ''}`);
  const scores = Object.entries(TYPE_SIGNALS)
    .map(([type, signals]) => {
      const matches = signals.filter((signal) => text.includes(normalizeText(signal)));
      return { type: type as DemandType, score: matches.length, matches };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = scores[0];
  const runnerUp = scores[1];
  const margin = best ? best.score - (runnerUp?.score || 0) : 0;
  const confidence =
    !best || best.score === 0
      ? 0.3
      : best.score === 1 || margin === 0
        ? 0.65
        : Math.min(0.95, 0.75 + best.score * 0.05);
  const threshold = options.threshold ?? CLASSIFIER_FALLBACK_THRESHOLD;
  const fallback = confidence < threshold;

  return {
    suggestedType: fallback ? 'nova_funcionalidade' : best.type,
    confidence,
    fallback,
    matchedSignals: best?.matches || [],
  };
}

export function evaluateDemandStartContract(input: {
  type: DemandType;
  title?: string;
  description?: string;
  fields?: Partial<DemandContractFields>;
}): DemandReadinessResult {
  const contract = getDemandStartContract(input.type);
  const fields = input.fields || {};
  const contractFields = contract?.fields || [];
  const requiredFields = contractFields.filter((field) => field.required);
  const completedFields = requiredFields.filter((field) => isFilled(fields[field.id]));
  const missingFields = requiredFields.filter((field) => !isFilled(fields[field.id]));
  const requiredScore =
    requiredFields.length === 0
      ? 100
      : Math.round((completedFields.length / requiredFields.length) * 100);
  const descriptionBonus = isFilled(input.description) ? 0 : -10;
  const scopeBlocked = hasBroadScope(`${input.title || ''} ${input.description || ''}`);
  const score = Math.max(0, Math.min(100, requiredScore + descriptionBonus));
  const incompleteStatus = contract?.incompleteStatus || 'needs_discovery';
  const status: DemandReadinessStatus = scopeBlocked
    ? 'needs_scope_breakdown'
    : missingFields.length === 0
      ? 'ready_for_development'
      : incompleteStatus;
  const isComplete = status === 'ready_for_development';
  const incompleteNextStep =
    contract?.incompleteNextStep || 'Complete os campos obrigatórios antes de prosseguir.';
  const classification = classifyDemandTypeF1(input);

  return {
    score,
    status,
    statusLabel: READINESS_STATUS_LABELS[status],
    isComplete,
    canSubmit: true,
    missingFields,
    completedFields,
    nextStep: isComplete
      ? 'Enviar para a squad com contrato preenchido.'
      : status === 'needs_scope_breakdown'
        ? 'Pode enviar para refinamento, mas a squad deve avaliar quebra de escopo antes de executar.'
        : `Pode enviar para refinamento. Lacunas registradas: ${incompleteNextStep}`,
    suggestedType: detectSuggestedDemandType({
      selectedType: input.type,
      title: input.title,
      description: input.description,
    }),
    classification,
  };
}

export function formatDemandStartContract(input: {
  type: DemandType;
  fields: Partial<DemandContractFields>;
  readiness: DemandReadinessResult;
  acceptedTypeSuggestion?: boolean;
}): string {
  const contract = getDemandStartContract(input.type);
  const contractFields = contract?.fields || [];
  const lines = contractFields.map((field) => {
    const value = input.fields[field.id]?.trim() || 'Não informado';
    return `- ${field.label}: ${value}`;
  });

  const suggestion = input.readiness.suggestedType
    ? `\nSugestão de tipo: ${input.readiness.suggestedType.label} (${input.readiness.suggestedType.confidence}%)\nSugestão aceita: ${input.acceptedTypeSuggestion ? 'Sim' : 'Não'}`
    : input.acceptedTypeSuggestion
      ? '\nSugestão de tipo aceita: Sim'
      : '';

  const typeLabel = DEMAND_TYPES[input.type]?.label || input.type;
  return `---\n**Contrato Inteligente de Início**\nTipo avaliado: ${typeLabel}\nStatus: ${input.readiness.statusLabel}\nScore de prontidão: ${input.readiness.score}%\nPróximo passo: ${input.readiness.nextStep}${suggestion}\n\nCampos do contrato:\n${lines.join('\n')}`;
}
