import { resolvePath } from '@shared/utils/paths';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Demand, DemandDomain } from '@shared/schema';
import { canonicalizeAgentConfigMap } from './agent-identity';

export const IMPROVEMENT_EXECUTION_CONFIG_VERSION = 'improvement-domain-parallel-v1';
export const IMPROVEMENT_PARALLEL_AGENTS = ['qa', 'ux', 'analista_de_dados'] as const;
export const IMPROVEMENT_REQUIRED_AGENTS = [
  'product_owner',
  'scrum_master',
  'qa',
  'ux',
  'analista_de_dados',
  'tech_lead',
] as const;

const REQUIRED_PROMPT_PLACEHOLDERS = ['domain', 'agentName', 'demandType'];
const ALLOWED_PROMPT_PLACEHOLDERS = new Set([...REQUIRED_PROMPT_PLACEHOLDERS, 'title']);

// ===== NEW TIERED VALIDATION TYPES =====
export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  section: string;
  message: string;
  severity: ValidationSeverity;
  category: 'structural' | 'actionable' | 'metrics' | 'semantic';
}

export interface ValidationOptions {
  level?: 1 | 2 | 3;
  forbiddenTechnologies?: string[];
  maxEffortDays?: number;
}

// Penalty map for soft warnings (score deductions)
const WARNING_PENALTIES: Record<string, number> = {
  roi_missing: 10,
  baseline_missing: 8,
  header_variation: 5,
  metrics_format: 5,
  experience_missing: 8,
  business_rules_missing: 8,
  acceptance_criteria_missing: 10,
  execution_plan_missing: 10,
  edge_cases_missing: 5,
  prd_link_missing: 5,
};

const DOMAIN_PROMPTS: Record<DemandDomain, string> = {
  padrao: [
    'Contexto de dominio: {domain}.',
    'Como {agentName}, avalie a melhoria {title} para o tipo {demandType} com foco em entrega incremental, metricas antes/depois e reducao de retrabalho.',
  ].join('\n'),
  legaltech_lgpd: [
    'Contexto de dominio: {domain}.',
    'Como {agentName}, avalie {title} para {demandType}. Não declare conformidade; vincule afirmações de LGPD a fonte curada e registre lacunas, riscos de dados e validação humana necessária.',
  ].join('\n'),
};

export interface PromptResolution {
  prompt: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
}

export interface QualityChecklistResult {
  qualityPassed: boolean; // true only if no 'error' severity issues
  qualityScore: number; // 0-100, penalized by warnings
  issues: ValidationIssue[]; // All issues with severity
  missingSections: string[];
  level: 1 | 2 | 3; // Validated level
  hardBlockReason?: string; // Primary reason if qualityPassed=false
}

export interface ExecutionMetricEvent {
  executionId: string;
  demandId: number;
  eventType: string;
  configVersion: string;
  timestamp: string;
  agentName?: string;
  startTime?: string;
  endTime?: string;
  durationMs?: number;
  agentsIncludedCount?: number;
  agentsOmittedCount?: number;
  pocModelUsed?: string;
  outputValidRate?: boolean;
  routerDecision?: Record<string, unknown>;
  qualityPassed?: boolean;
  missingSections?: string[];
  fallbackUsed?: boolean;
  fallbackReason?: string;
  metadata?: Record<string, unknown>;
}

export class ImprovementExecutionService {
  createExecutionId(): string {
    return `exec_${Date.now()}_${randomUUID().slice(0, 8)}`;
  }

  normalizeDomain(domain: unknown): DemandDomain {
    return typeof domain === 'string' && domain.trim().length > 0 ? domain.trim() : 'padrao';
  }

  resolveDomainPrompt(domain: DemandDomain, demand: Demand, agentName: string): PromptResolution {
    const template = DOMAIN_PROMPTS[domain] || DOMAIN_PROMPTS.padrao;
    const validation = this.validatePromptTemplate(template);

    if (!validation.valid) {
      return {
        prompt: this.renderPrompt(DOMAIN_PROMPTS.padrao, 'padrao', demand, agentName),
        fallbackUsed: true,
        fallbackReason: validation.reason,
      };
    }

    return {
      prompt: this.renderPrompt(template, domain, demand, agentName),
      fallbackUsed: false,
    };
  }

  getImprovementAgentConfigs<
    T extends { system_prompt: string; description: string; model?: string },
  >(
    configs: Record<string, T>,
    demand: Demand,
  ): { configs: Record<string, T>; fallbackUsed: boolean; fallbackReason?: string } {
    const canonicalConfigs = canonicalizeAgentConfigMap(configs);

    if (demand.type !== 'melhoria') {
      return { configs: canonicalConfigs, fallbackUsed: false };
    }

    const domain = this.normalizeDomain(demand.domain);
    const selectedConfigs: Record<string, T> = {};
    let fallbackUsed = false;
    const fallbackReasons: string[] = [];

    for (const agentName of IMPROVEMENT_REQUIRED_AGENTS) {
      const baseConfig = canonicalConfigs[agentName];
      if (!baseConfig) continue;

      const domainPrompt = this.resolveDomainPrompt(domain, demand, agentName);
      if (domainPrompt.fallbackUsed) {
        fallbackUsed = true;
        fallbackReasons.push(`${agentName}: ${domainPrompt.fallbackReason}`);
      }

      selectedConfigs[agentName] = {
        ...baseConfig,
        system_prompt: `${baseConfig.system_prompt}\n\n--- DOMINIO DA DEMANDA ---\n${domainPrompt.prompt}`,
      };
    }

    return {
      configs: selectedConfigs,
      fallbackUsed,
      fallbackReason: fallbackReasons.length > 0 ? fallbackReasons.join('; ') : undefined,
    };
  }

  validateImprovementPlan(content: string, options?: ValidationOptions): QualityChecklistResult {
    const level = options?.level ?? 3; // Default to Level 3 (Completo) for backwards compatibility
    const forbiddenTechnologies = options?.forbiddenTechnologies ?? [];
    const maxEffortDays = options?.maxEffortDays ?? 14;

    const normalized = this.normalizeText(content);
    const issues: ValidationIssue[] = [];
    let qualityScore = 100;

    // ===== HARD BLOCKS (error severity) =====

    // 1. Check for forbidden technologies without justification
    // Only block if the technology is mentioned AND there's no justification nearby
    for (const tech of forbiddenTechnologies) {
      const normalizedTech = this.normalizeText(tech);
      if (normalized.includes(normalizedTech)) {
        // Check if there's a justification mention near the technology
        const hasJustification =
          normalized.includes('justificativa') ||
          normalized.includes('motivo') ||
          normalized.includes('razao') ||
          normalized.includes('nao fazer'); // If it's in "Não Fazer" section, it's OK
        if (!hasJustification) {
          issues.push({
            section: 'Tecnologias',
            message: `Tecnologia "${tech}" fora do stack sem justificativa`,
            severity: 'error',
            category: 'semantic',
          });
        }
      }
    }

    // 2. Check scope exceeds limit (semantic analysis for effort mentions)
    const effortMatch = content.match(/(\d+)\s*(dias?|semanas?|weeks?|days?)/i);
    if (effortMatch) {
      const effortValue = parseInt(effortMatch[1], 10);
      const isWeeks = /semanas?|weeks?/i.test(effortMatch[2]);
      const effortDays = isWeeks ? effortValue * 5 : effortValue;
      if (effortDays > maxEffortDays) {
        issues.push({
          section: 'Escopo',
          message: `Escopo excede limite máximo (${effortDays} dias > ${maxEffortDays} dias)`,
          severity: 'error',
          category: 'semantic',
        });
      }
    }

    // 3. No objective (§4 or §4.1) — HARD BLOCK for all levels
    const hasObjective =
      /##?\s*(4|4\.1)?\.?\s*objetivo/i.test(normalized) ||
      normalized.includes('objetivo principal') ||
      normalized.includes('objetivo desta melhoria');
    if (!hasObjective) {
      issues.push({
        section: '## 4. Objetivo',
        message: 'Nenhum objetivo definido (§4 Objetivo ausente)',
        severity: 'error',
        category: 'structural',
      });
    }

    // 4. No deliverable (§5.1 Fazer Agora) — HARD BLOCK for all levels
    const hasFazerAgora =
      /##?#?\s*(5\.1)?\.?\s*fazer agora/i.test(normalized) ||
      normalized.includes('fazer agora') ||
      normalized.includes('entrega imediata');
    if (!hasFazerAgora) {
      issues.push({
        section: '### 5.1 Fazer Agora',
        message: 'Nenhuma entrega implementável (§5.1 Fazer Agora ausente)',
        severity: 'error',
        category: 'structural',
      });
    }

    // ===== LEVEL-SPECIFIC HARD BLOCKS =====

    if (level >= 1) {
      // Level 1: At least 1 acceptance criterion
      const hasAcceptanceCriteria =
        normalized.includes('criterio') ||
        normalized.includes('- [ ]') ||
        normalized.includes('criterios de aceite');
      if (!hasAcceptanceCriteria) {
        issues.push({
          section: '## 11. Critérios de Aceite',
          message: 'Ao menos 1 critério de aceite é obrigatório',
          severity: level === 1 ? 'error' : 'warning',
          category: 'actionable',
        });
        if (level > 1) qualityScore -= WARNING_PENALTIES['acceptance_criteria_missing'];
      }
    }

    if (level >= 2) {
      // Level 2: Risks and Mitigations (at least 1)
      const hasRisks = normalized.includes('risco') && normalized.includes('mitigacao');
      if (!hasRisks) {
        issues.push({
          section: '## 10. Riscos e Mitigações',
          message: 'Riscos e Mitigações obrigatórios para Nível 2+',
          severity: 'error',
          category: 'structural',
        });
      }

      // Level 2: Simple metrics (any baseline/meta)
      const hasMetrics =
        normalized.includes('baseline') ||
        normalized.includes('meta') ||
        normalized.includes('alvo');
      if (!hasMetrics) {
        issues.push({
          section: '## 8. Métricas de Sucesso',
          message: 'Métricas simples (baseline ou meta) obrigatórias para Nível 2+',
          severity: 'error',
          category: 'metrics',
        });
      }

      // Level 2: Tasks with IDs (T1, T2...)
      // This is checked in validateImprovementTasks, but we can note it here
    }

    if (level >= 3) {
      // Level 3: Complete metrics table with Baseline + Meta + Como Medir
      const hasCompleteMetrics =
        normalized.includes('baseline') &&
        (normalized.includes(' meta') || normalized.includes('alvo')) &&
        normalized.includes('como medir');
      if (!hasCompleteMetrics) {
        issues.push({
          section: '## 8. Métricas de Sucesso',
          message:
            'Tabela de métricas completa (Baseline + Meta + Como Medir) obrigatória para Nível 3',
          severity: 'error',
          category: 'metrics',
        });
      }

      // Level 3: All actionable sections (11, 12, 13)
      const hasExecutionPlan =
        normalized.includes('plano de execucao') || normalized.includes('12. plano');
      if (!hasExecutionPlan) {
        issues.push({
          section: '## 12. Plano de Execução',
          message: 'Plano de Execução obrigatório para Nível 3',
          severity: 'error',
          category: 'actionable',
        });
      }

      const hasEdgeCases =
        normalized.includes('casos de borda') || normalized.includes('13. casos');
      if (!hasEdgeCases) {
        issues.push({
          section: '## 13. Casos de Borda',
          message: 'Casos de Borda obrigatórios para Nível 3',
          severity: 'error',
          category: 'actionable',
        });
      }
    }

    // ===== SOFT WARNINGS (warning severity) =====

    // ROI missing
    const hasROI = normalized.includes('roi') || normalized.includes('retorno');
    if (!hasROI) {
      issues.push({
        section: 'ROI',
        message: 'ROI ou retorno não especificado',
        severity: 'warning',
        category: 'metrics',
      });
      qualityScore -= WARNING_PENALTIES['roi_missing'];
    }

    // Baseline missing in metrics (if metrics section exists but no baseline)
    const hasMetricsSection =
      normalized.includes('8. metricas') || normalized.includes('metricas de sucesso');
    if (hasMetricsSection && !normalized.includes('baseline')) {
      issues.push({
        section: '## 8. Métricas de Sucesso',
        message: 'Baseline ausente nas métricas',
        severity: 'warning',
        category: 'metrics',
      });
      qualityScore -= WARNING_PENALTIES['baseline_missing'];
    }

    // Experience section missing (warning for level < 3)
    if (level < 3) {
      const hasExperience =
        normalized.includes('experiencia esperada') ||
        normalized.includes('6. experiencia') ||
        normalized.includes('jornada do usuario');
      if (!hasExperience) {
        issues.push({
          section: '## 6. Experiência Esperada',
          message: 'Experiência Esperada ausente',
          severity: 'warning',
          category: 'actionable',
        });
        qualityScore -= WARNING_PENALTIES['experience_missing'];
      }
    }

    // Business rules missing (warning for level < 3)
    if (level < 3) {
      const hasBusinessRules =
        normalized.includes('regras de negocio') || normalized.includes('7. regras');
      if (!hasBusinessRules) {
        issues.push({
          section: '## 7. Regras de Negócio',
          message: 'Regras de Negócio ausentes',
          severity: 'warning',
          category: 'structural',
        });
        qualityScore -= WARNING_PENALTIES['business_rules_missing'];
      }
    }

    // Execution plan missing (warning for level < 3)
    if (level < 3) {
      const hasExecutionPlan =
        normalized.includes('plano de execucao') || normalized.includes('12. plano');
      if (!hasExecutionPlan) {
        issues.push({
          section: '## 12. Plano de Execução',
          message: 'Plano de Execução ausente',
          severity: 'warning',
          category: 'actionable',
        });
        qualityScore -= WARNING_PENALTIES['execution_plan_missing'];
      }
    }

    // Edge cases missing (warning for level < 3)
    if (level < 3) {
      const hasEdgeCases =
        normalized.includes('casos de borda') || normalized.includes('13. casos');
      if (!hasEdgeCases) {
        issues.push({
          section: '## 13. Casos de Borda',
          message: 'Casos de Borda ausentes',
          severity: 'warning',
          category: 'actionable',
        });
        qualityScore -= WARNING_PENALTIES['edge_cases_missing'];
      }
    }

    // Ensure score doesn't go below 0
    qualityScore = Math.max(0, qualityScore);

    // Determine if quality passed (no errors)
    const errors = issues.filter((i) => i.severity === 'error');
    const qualityPassed = errors.length === 0;
    const hardBlockReason = errors.length > 0 ? errors[0].message : undefined;

    const missingSections = issues.filter((i) => i.severity === 'error').map((i) => i.section);

    return {
      qualityPassed,
      qualityScore,
      issues,
      missingSections,
      level,
      hardBlockReason,
    };
  }

  /**
   * Valida semanticamente o checklist de tasks de uma demanda de MELHORIA.
   * Garante que o plano contém ao menos uma task [IMPLEMENTAÇÃO] — mudança real —
   * e não é apenas um plano de diagnóstico, medição ou decisão.
   */
  validateImprovementTasks(content: string, options?: ValidationOptions): QualityChecklistResult {
    const level = options?.level ?? 3;
    const normalized = this.normalizeText(content);
    const issues: ValidationIssue[] = [];
    let qualityScore = 100;

    // ===== HARD BLOCKS =====

    // 1. REGRA CENTRAL: ao menos uma task [IMPLEMENTAÇÃO] — HARD BLOCK for all levels
    const hasImplementationTask =
      normalized.includes('[implementacao]') || normalized.includes('[implementação]');
    if (!hasImplementationTask) {
      issues.push({
        section: '[IMPLEMENTAÇÃO]',
        message:
          '[IMPLEMENTAÇÃO] ausente — o checklist não contém nenhuma task que aplique mudança real',
        severity: 'error',
        category: 'semantic',
      });
    }

    // 2. Seção "Agora" obrigatória — HARD BLOCK for all levels
    // Accept variations: "## Agora", "## agora", just "agora" with tasks below
    const hasAgoraSection =
      normalized.includes('## agora') ||
      normalized.includes('agora\n') ||
      (normalized.includes('agora') && (normalized.includes('**t1') || normalized.includes('- [')));
    if (!hasAgoraSection) {
      issues.push({
        section: '## Agora',
        message: 'Seção "## Agora" ausente no checklist',
        severity: 'error',
        category: 'structural',
      });
    }

    // ===== LEVEL-SPECIFIC REQUIREMENTS =====

    if (level >= 2) {
      // Level 2+: Tasks with IDs (T1, T2...)
      // Match patterns like **T1:**, **T2:**, or just T1:, T2:
      const hasTaskIds =
        /T\d+:/i.test(content) || content.includes('**T1') || content.includes('**t1');
      if (!hasTaskIds) {
        issues.push({
          section: 'Tasks',
          message: 'Nenhuma task com formato válido (T1, T2...) encontrada',
          severity: 'error',
          category: 'structural',
        });
      }
    }

    if (level >= 3) {
      // Level 3: All structural sections - with flexible matching
      const requiredStructure: Array<{ label: string; keywords: string[] }> = [
        { label: '## Depois', keywords: ['## depois', 'depois\n'] },
        { label: '## Não Fazer', keywords: ['## nao fazer', 'nao fazer\n', '## não fazer'] },
        {
          label: '## Métricas de Sucesso',
          keywords: ['## metricas de sucesso', 'metricas de sucesso'],
        },
      ];
      for (const { label, keywords } of requiredStructure) {
        const found = keywords.some((kw) => normalized.includes(kw));
        if (!found) {
          issues.push({
            section: label,
            message: `Seção "${label}" ausente no checklist`,
            severity: 'error',
            category: 'structural',
          });
        }
      }
    }

    // ===== SOFT WARNINGS =====

    // Tasks without "Vinculado ao PRD:" — WARNING
    const agoraBlock = this.extractSection(content, '## Agora');
    if (agoraBlock) {
      const normalizedAgora = this.normalizeText(agoraBlock);
      if (!normalizedAgora.includes('vinculado ao prd')) {
        issues.push({
          section: '## Agora',
          message: 'Tasks em "## Agora" sem vínculo com o PRD (campo "Vinculado ao PRD:" ausente)',
          severity: 'warning',
          category: 'semantic',
        });
        qualityScore -= WARNING_PENALTIES['prd_link_missing'];
      }
    }

    // Missing "Depois" section — WARNING for level < 3
    if (level < 3 && !normalized.includes('## depois')) {
      issues.push({
        section: '## Depois',
        message: 'Seção "## Depois" ausente',
        severity: 'warning',
        category: 'structural',
      });
      qualityScore -= 5;
    }

    // Missing "Não Fazer" section — WARNING for level < 3
    if (level < 3 && !normalized.includes('## nao fazer')) {
      issues.push({
        section: '## Não Fazer',
        message: 'Seção "## Não Fazer" ausente',
        severity: 'warning',
        category: 'structural',
      });
      qualityScore -= 5;
    }

    // Missing "Métricas de Sucesso" section — WARNING for level < 3
    if (level < 3 && !normalized.includes('## metricas de sucesso')) {
      issues.push({
        section: '## Métricas de Sucesso',
        message: 'Seção "## Métricas de Sucesso" ausente',
        severity: 'warning',
        category: 'metrics',
      });
      qualityScore -= 5;
    }

    // Ensure score doesn't go below 0
    qualityScore = Math.max(0, qualityScore);

    // Determine if quality passed (no errors)
    const errors = issues.filter((i) => i.severity === 'error');
    const qualityPassed = errors.length === 0;
    const hardBlockReason = errors.length > 0 ? errors[0].message : undefined;

    const missingSections = issues
      .filter((i) => i.severity === 'error')
      .map((i) => `[tasks] ${i.section}: ${i.message}`);

    return {
      qualityPassed,
      qualityScore,
      issues,
      missingSections,
      level,
      hardBlockReason,
    };
  }

  recordEvent(event: ExecutionMetricEvent): void {
    const dataDir = resolvePath('data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const eventWithDefaults = {
      ...event,
      configVersion: event.configVersion || IMPROVEMENT_EXECUTION_CONFIG_VERSION,
      timestamp: event.timestamp || new Date().toISOString(),
    };

    fs.appendFileSync(
      path.join(dataDir, 'execution_events.jsonl'),
      `${JSON.stringify(eventWithDefaults)}\n`,
      'utf8',
    );
  }

  private validatePromptTemplate(template: string): { valid: boolean; reason?: string } {
    if (template.length < 80 || template.length > 1200) {
      return { valid: false, reason: 'prompt_size_out_of_bounds' };
    }

    const malformedBraces =
      (template.match(/{/g)?.length || 0) !== (template.match(/}/g)?.length || 0);
    if (malformedBraces) {
      return { valid: false, reason: 'malformed_placeholder_braces' };
    }

    const placeholders = [...template.matchAll(/{([^{}]+)}/g)].map((match) => match[1]);
    for (const required of REQUIRED_PROMPT_PLACEHOLDERS) {
      if (!placeholders.includes(required)) {
        return { valid: false, reason: `missing_required_placeholder:${required}` };
      }
    }

    const invalidPlaceholder = placeholders.find(
      (placeholder) => !ALLOWED_PROMPT_PLACEHOLDERS.has(placeholder),
    );
    if (invalidPlaceholder) {
      return { valid: false, reason: `unsupported_placeholder:${invalidPlaceholder}` };
    }

    return { valid: true };
  }

  private renderPrompt(
    template: string,
    domain: DemandDomain,
    demand: Demand,
    agentName: string,
  ): string {
    return template
      .replaceAll('{domain}', domain)
      .replaceAll('{agentName}', agentName)
      .replaceAll('{demandType}', demand.type)
      .replaceAll('{title}', demand.title);
  }

  private normalizeText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Extrai o conteúdo entre um heading e o próximo heading de mesmo nível */
  private extractSection(content: string, heading: string): string | null {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`${escapedHeading}\\s*([\\s\\S]*?)(?=^##\\s|$)`, 'm');
    const match = content.match(regex);
    return match ? match[1] : null;
  }
}

export const improvementExecutionService = new ImprovementExecutionService();
