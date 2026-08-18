/**
 * Validação de documentos PRD e Tasks Document
 *
 * Este módulo valida se os documentos gerados seguem os templates mínimos
 * e contêm todos os metadados e estruturas obrigatórias.
 */

export interface ValidationError {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

/**
 * Valida se um documento Tasks contém todos os elementos obrigatórios
 */
export function validateTasksDocument(content: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  // O gerador produz campos soltos no topo (não uma seção ## Metadados).
  // Validamos a presença desses campos na forma que o gerador os emite.
  // Aceita "**Versão:** 1.0.0" (formato canônico do template) e "**Versão**: 1.0.0"
  const hasVersionField = /\*\*Vers[aã]o:?\*\*:?/i.test(content);
  if (!hasVersionField) {
    warnings.push({
      field: 'versao',
      message: 'Campo "Versão" ausente no cabeçalho do checklist',
      severity: 'warning',
    });
  }

  // Validar prioridade
  // Suporta **Prioridade:** ou **Prioridade**:
  // Aceita as 4 prioridades do domínio (prioritySchema: baixa, media, alta, critica)
  const priorityRegex = /\*\*Prioridade:?\*\*:?\s*(Alta|Média|Cr[ií]tica|Baixa)/i;
  if (!priorityRegex.test(content)) {
    errors.push({
      field: 'prioridade',
      message: 'Campo "Prioridade" ausente ou inválido (deve ser Crítica, Alta, Média ou Baixa)',
      severity: 'error',
    });
  }

  // Validar responsável
  const responsibleRegex = /\*\*Responsável:?\*\*:?\s*(.+)/;
  if (!responsibleRegex.test(content)) {
    errors.push({
      field: 'responsavel',
      message: 'Campo "Responsável" ausente',
      severity: 'error',
    });
  } else {
    const match = content.match(responsibleRegex);
    if (match && match[1].includes('[Time/Área]')) {
      warnings.push({
        field: 'responsavel',
        message: 'Campo "Responsável" ainda contém placeholder',
        severity: 'warning',
      });
    }
  }

  // Validar status
  const statusRegex = /\*\*Status:?\*\*:?\s*(Não Iniciado|Em Progresso|Concluído)/i;
  if (!statusRegex.test(content)) {
    errors.push({
      field: 'status',
      message:
        'Campo "Status" ausente ou inválido (deve ser Não Iniciado, Em Progresso ou Concluído)',
      severity: 'error',
    });
  }

  // Validar formato dos IDs de tarefas (T1, T2, etc.)
  // Suporta **T1:** ou **T1**: ou **T1** :
  const taskIdRegex = /\*\*T\d+:?\*\*[:\s]*/g;
  const taskIds = content.match(taskIdRegex);

  if (!taskIds || taskIds.length === 0) {
    errors.push({
      field: 'tarefas',
      message: 'Nenhuma tarefa encontrada com formato válido (T1, T2, etc.)',
      severity: 'error',
    });
  }

  // Validar se cada tarefa tem critérios de aceite
  if (taskIds) {
    taskIds.forEach((taskId) => {
      const taskNumber = taskId.match(/T(\d+)/)?.[1];
      const taskSection = extractTaskSection(content, taskNumber!);

      if (taskSection && !taskSection.includes('Critérios de aceite:')) {
        errors.push({
          field: `tarefa_${taskNumber}`,
          message: `Tarefa ${taskNumber} não possui critérios de aceite`,
          severity: 'error',
        });
      }

      // Verificar se critérios de aceite não estão vazios
      if (taskSection && taskSection.includes('Critérios de aceite: [Lista de condições]')) {
        warnings.push({
          field: `tarefa_${taskNumber}`,
          message: `Tarefa ${taskNumber} possui critérios de aceite vazios (placeholder)`,
          severity: 'warning',
        });
      }

      // Validar vínculo com PRD
      if (taskSection && !taskSection.includes('Vinculado ao PRD:')) {
        warnings.push({
          field: `tarefa_${taskNumber}`,
          message: `Tarefa ${taskNumber} não possui vínculo explícito com requisitos do PRD`,
          severity: 'warning',
        });
      }
    });
  }

  // Validar seção de métricas de sucesso
  if (!content.includes('## Métricas de Sucesso')) {
    warnings.push({
      field: 'metricas',
      message: 'Seção "Métricas de Sucesso" ausente',
      severity: 'warning',
    });
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Valida se um documento TSD (Technical Specification Document) contém todos os elementos obrigatórios.
 * Também aceita documentos TDD legados (título "# TDD -") para compatibilidade retroativa.
 */
export function validateTDDDocument(content: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  const hasSection = (sectionName: string) => {
    const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Suporta: "## Seção", "## 1. Seção", "## 🎯 Seção"
    return new RegExp(
      `^##\\s+(?:\\d+\\.\\s*)?(?:[\\u2700-\\u27BF]|[\\uE000-\\uF8FF]|\\uD83C[\\uDC00-\\uDFFF]|\\uD83D[\\uDC00-\\uDFFF]|[\\u2011-\\u26FF]|\\uD83E[\\uDD10-\\uDDFF])?\\s*${escaped}`,
      'im',
    ).test(content);
  };

  // Aceita TSD (novo) ou TDD (legado)
  const hasTSDTitle = /^#\s+TSD\s*[-–—]\s*.+/im.test(content);
  const hasTDDTitle = /^#\s+TDD\s*[-–—]\s*.+/im.test(content);
  if (!hasTSDTitle && !hasTDDTitle) {
    warnings.push({
      field: 'titulo',
      message: 'Título no formato "# TSD - [Nome]" ausente',
      severity: 'warning',
    });
  }

  // Seções obrigatórias do TSD
  const requiredSections = [
    { name: 'Contexto Técnico', aliases: ['Visão Geral', 'Abstract', 'Overview'] },
    {
      name: 'Decisões de Design',
      aliases: ['Arquitetura Proposta', 'Arquitetura', 'Architecture', 'Design'],
    },
    {
      name: 'Arquitetura e Componentes',
      aliases: ['Componentes', 'Arquitetura e Componentes Afetados'],
    },
  ];

  // Seções obrigatórias com conteúdo verificável (code block esperado)
  const technicalSections = [
    { name: 'Modelo de Dados', aliases: ['Data Schema', 'Schema', 'Database'] },
    { name: 'Contratos de API', aliases: ['Definição de APIs', 'Contratos', 'API', 'Endpoints'] },
    { name: 'Fluxo de Sequência', aliases: ['Sequence', 'Flow', 'Fluxo de Sequencia'] },
  ];

  // Seções recomendadas (warnings se ausentes)
  const recommendedSections = [
    {
      name: 'Requisitos Não-Funcionais',
      aliases: ['NFR', 'Performance', 'Segurança', 'Considerações de Performance'],
    },
    { name: 'Tratamento de Erros', aliases: ['Edge Cases', 'Erros', 'Error Handling'] },
    { name: 'Plano de Rollout', aliases: ['Rollout', 'Monitoramento', 'Deploy', 'Feature Flag'] },
    {
      name: 'Checklist de Implementação',
      aliases: ['Checklist', 'Alternativas Consideradas', 'Alternativas'],
    },
  ];

  // Validar seções obrigatórias
  [...requiredSections, ...technicalSections].forEach(({ name, aliases }) => {
    const found = hasSection(name) || aliases.some((alias) => hasSection(alias));
    if (!found) {
      errors.push({
        field: name.toLowerCase().replace(/\s+/g, '_'),
        message: `Seção obrigatória "${name}" ausente no TSD`,
        severity: 'error',
      });
    }
  });

  // Validar seções recomendadas
  recommendedSections.forEach(({ name, aliases }) => {
    const found = hasSection(name) || aliases.some((alias) => hasSection(alias));
    if (!found) {
      warnings.push({
        field: name.toLowerCase().replace(/\s+/g, '_'),
        message: `Seção recomendada "${name}" ausente no TSD`,
        severity: 'warning',
      });
    }
  });

  // Validar presença de blocos de código técnico (schema, API, sequência)
  const hasCodeBlock = /```[\s\S]*?```/.test(content);
  const hasMermaid = /```mermaid[\s\S]*?```/i.test(content);
  const hasTechnicalContent = hasCodeBlock || hasMermaid;

  if (!hasTechnicalContent) {
    warnings.push({
      field: 'conteudo_tecnico',
      message: 'TSD não contém blocos de código, schema ou diagrama Mermaid',
      severity: 'warning',
    });
  }

  // Validar metadados da tabela de cabeçalho
  const hasAuthor = /\*?\*?Autor\*?\*?:?\s*.+/i.test(content);
  const hasDate = /\*?\*?Data\*?\*?:?\s*.+/i.test(content);
  const hasStatus = /\*?\*?Status\*?\*?:?\s*.+/i.test(content);
  const hasVersion = /\*?\*?Vers[aã]o\*?\*?:?\s*.+/i.test(content);

  if (!hasAuthor) {
    warnings.push({
      field: 'autor',
      message: 'Campo "Autor" ausente no cabeçalho do TSD',
      severity: 'warning',
    });
  }
  if (!hasDate) {
    warnings.push({
      field: 'data',
      message: 'Campo "Data" ausente no cabeçalho do TSD',
      severity: 'warning',
    });
  }
  if (!hasStatus) {
    warnings.push({
      field: 'status',
      message: 'Campo "Status" ausente no cabeçalho do TSD',
      severity: 'warning',
    });
  }
  if (!hasVersion) {
    warnings.push({
      field: 'versao',
      message: 'Campo "Versão" ausente no cabeçalho do TSD',
      severity: 'warning',
    });
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Valida se um documento PRD contém todos os elementos obrigatórios
 */
export function validatePRDDocument(content: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  const hasSection = (sectionName: string) => {
    const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Suporta: "## Seção", "## 1. Seção", "## 🎯 Seção", "## 1. 🎯 Seção"
    return new RegExp(
      `^##\\s+(?:\\d+\\.\\s*)?(?:[\\u2700-\\u27BF]|[\\uE000-\\uF8FF]|\\uD83C[\\uDC00-\\uDFFF]|\\uD83D[\\uDC00-\\uDFFF]|[\\u2011-\\u26FF]|\\uD83E[\\uDD10-\\uDDFF])?\\s*${escaped}`,
      'im',
    ).test(content);
  };

  const isBusinessPRD = [
    'Resumo Executivo',
    'Decisão De Produto',
    'Decisao De Produto',
    'Contexto e Problema',
    'Problema e Oportunidade',
    'Público Impactado',
    'Publico Impactado',
    'Objetivo e Benefícios',
    'Objetivos de Negócio',
    'Objetivos de Negocio',
    'Escopo da Entrega',
    'Escopo',
    'Experiência Esperada',
    'Experiencia Esperada',
    'Métricas de Sucesso',
    'Metricas de Sucesso',
  ].some(hasSection);

  if (isBusinessPRD) {
    const recommendedSections = [
      'Decisão De Produto',
      'Problema e Oportunidade',
      'Escopo da Entrega',
      'Métricas de Sucesso',
      'Riscos e Mitigações',
      'Plano de Execução',
    ];

    recommendedSections.forEach((section) => {
      if (!hasSection(section)) {
        // Fallback para nomes legados ou similares se não encontrar o exato
        const legacyMatch =
          section === 'Decisão De Produto' &&
          (hasSection('Resumo Executivo') || hasSection('Decisao De Produto'));
        const legacyMatch2 =
          section === 'Problema e Oportunidade' && hasSection('Contexto e Problema');
        const legacyMatch3 =
          section === 'Riscos e Mitigações' &&
          (hasSection('Riscos e Cuidados') || hasSection('Riscos e Mitigacoes'));
        const legacyMatch4 =
          section === 'Plano de Execução' &&
          (hasSection('Plano de Entrega') || hasSection('Plano de Execucao'));
        const legacyMatch5 = section === 'Métricas de Sucesso' && hasSection('Metricas de Sucesso');

        if (!legacyMatch && !legacyMatch2 && !legacyMatch3 && !legacyMatch4 && !legacyMatch5) {
          warnings.push({
            field: section.toLowerCase().replace(/\s+/g, '_'),
            message: `Seção recomendada "${section}" ausente no PRD de negócio`,
            severity: 'warning',
          });
        }
      }
    });

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  const hasScopeSection = hasSection('Escopo') || content.includes('## 🎯 Escopo');
  const hasInScope = content.includes('### In Scope') || content.includes('### Faremos');
  const hasOutOfScope =
    content.includes('### Out of Scope') || content.includes('### Não Faremos Agora');

  // Validar seção de escopo
  if (!hasScopeSection) {
    errors.push({
      field: 'escopo',
      message: 'Seção "Escopo" ou "Escopo da Entrega" ausente no documento',
      severity: 'error',
    });
  }

  // Validar In Scope e Out of Scope
  if (!hasInScope) {
    errors.push({
      field: 'in_scope',
      message: 'Subseção "In Scope" ou "Faremos" ausente',
      severity: 'error',
    });
  }

  if (!hasOutOfScope) {
    errors.push({
      field: 'out_scope',
      message: 'Subseção "Out of Scope" ou "Não Faremos Agora" ausente',
      severity: 'error',
    });
  }

  // Validar requisitos funcionais
  if (!hasSection('Requisitos Funcionais') && !content.includes('## 🎯 Requisitos Funcionais')) {
    errors.push({
      field: 'requisitos_funcionais',
      message: 'Seção "Requisitos Funcionais" ausente',
      severity: 'error',
    });
  }

  // Validar formato dos requisitos funcionais (RF1, RF2, etc.)
  const rfRegex = /(?:###\s*)?RF\d+:|- RF\d+:/g;
  const functionalReqs = content.match(rfRegex);

  if (!functionalReqs || functionalReqs.length === 0) {
    errors.push({
      field: 'requisitos_funcionais',
      message: 'Nenhum requisito funcional encontrado com formato válido (RF1, RF2, etc.)',
      severity: 'error',
    });
  }

  // Validar se cada RF tem critérios de aceite
  if (functionalReqs) {
    functionalReqs.forEach((rf) => {
      const rfNumber = rf.match(/RF(\d+)/)?.[1];
      const rfSection = extractRFSection(content, rfNumber!);

      if (rfSection && !rfSection.includes('**Critérios de Aceite**:')) {
        errors.push({
          field: `rf_${rfNumber}`,
          message: `Requisito Funcional ${rfNumber} não possui critérios de aceite`,
          severity: 'error',
        });
      }

      // Validar prioridade do RF
      if (rfSection && !rfSection.includes('**Prioridade**:')) {
        warnings.push({
          field: `rf_${rfNumber}`,
          message: `Requisito Funcional ${rfNumber} não possui prioridade definida`,
          severity: 'warning',
        });
      }
    });
  }

  // Validar requisitos não funcionais
  if (
    !hasSection('Requisitos Não Funcionais') &&
    !content.includes('## 🛠️ Requisitos Não Funcionais')
  ) {
    warnings.push({
      field: 'requisitos_nao_funcionais',
      message: 'Seção "Requisitos Não Funcionais" ausente',
      severity: 'warning',
    });
  }

  // Validar critérios de aceitação gerais
  if (!hasSection('Critérios de Aceitação Gerais') && !hasSection('Critérios de Aceitação')) {
    errors.push({
      field: 'criterios_aceitacao',
      message: 'Seção "Critérios de Aceitação Gerais" ausente',
      severity: 'error',
    });
  }

  // Validar métricas de sucesso
  if (!content.includes('Métricas de Sucesso')) {
    warnings.push({
      field: 'metricas',
      message: 'Seção "Métricas de Sucesso" ausente',
      severity: 'warning',
    });
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Extrai a seção de uma tarefa específica do documento
 */
function extractTaskSection(content: string, taskNumber: string): string | null {
  const taskRegex = new RegExp(
    `\\*\\*T${taskNumber}\\*\\*:([\\s\\S]*?)(?=\\*\\*T\\d+\\*\\*:|### |## |$)`,
    'm',
  );
  const match = content.match(taskRegex);
  return match ? match[1] : null;
}

/**
 * Extrai a seção de um requisito funcional específico do documento
 */
function extractRFSection(content: string, rfNumber: string): string | null {
  const rfRegex = new RegExp(`### RF${rfNumber}:([\\s\\S]*?)(?=### RF\\d+:|## |$)`, 'm');
  const match = content.match(rfRegex);
  return match ? match[1] : null;
}

/**
 * Valida ambos os documentos (PRD e Tasks) e retorna um resultado consolidado
 */
export function validateDocuments(
  prdContent: string,
  tasksContent: string,
): {
  prd: ValidationResult;
  tasks: ValidationResult;
  overallValid: boolean;
} {
  const prdValidation = validatePRDDocument(prdContent);
  const tasksValidation = validateTasksDocument(tasksContent);

  return {
    prd: prdValidation,
    tasks: tasksValidation,
    overallValid: prdValidation.isValid && tasksValidation.isValid,
  };
}

/**
 * Formata os erros de validação em uma mensagem legível
 */
export function formatValidationErrors(
  validation: ValidationResult,
  documentType: 'PRD' | 'Tasks',
): string {
  const messages: string[] = [`\n❌ Erros de validação no ${documentType}:\n`];

  if (validation.errors.length > 0) {
    messages.push('**Erros críticos:**');
    validation.errors.forEach((error, index) => {
      messages.push(`${index + 1}. [${error.field}] ${error.message}`);
    });
  }

  if (validation.warnings.length > 0) {
    messages.push('\n⚠️ **Avisos:**');
    validation.warnings.forEach((warning, index) => {
      messages.push(`${index + 1}. [${warning.field}] ${warning.message}`);
    });
  }

  return messages.join('\n');
}
