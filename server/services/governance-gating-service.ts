import type { Demand, RefinementInteraction, CoverageAnalysisResult } from '@shared/schema';

export interface GatingResult {
  passed: boolean;
  score: number;
  errors: string[];
  omissions: { category: string; item: string; criticality: 'HIGH' | 'MEDIUM' | 'LOW' }[];
}

export class GovernanceGatingService {
  /**
   * Performs structural validation on the document content.
   * Checks for mandatory sections and requirement <=> criteria linkage.
   */
  static validateStructuralGate(
    demand: Demand,
    prdContent: string,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const content = prdContent.toLowerCase();

    // 1. Check for mandatory sections (pilot)
    const mandatorySections = [
      'requisitos funcionais',
      'critérios de aceite',
      'dependências',
      'decisões',
    ];

    for (const section of mandatorySections) {
      if (!content.includes(section)) {
        errors.push(`Seção obrigatória ausente: ${section}`);
      }
    }

    // 2. Checklist Score validation (Hard Stop < 90%)
    const checklist = demand.sectionChecklist || {};
    const totalItems = Object.keys(checklist).length;
    if (totalItems > 0) {
      const completedItems = Object.values(checklist).filter((v) => v).length;
      const score = (completedItems / totalItems) * 100;
      if (score < 90) {
        errors.push(
          `Completude detalhada insuficiente (${score.toFixed(0)}%). Necessário no mínimo 90%.`,
        );
      }
    }

    // 3. Linkage validation: Requirement <=> Criteria
    // This is a simplified regex-based check for the pilot
    const hasRequirements = content.includes('requisito');
    const hasCriteria = content.includes('critério');

    if (hasRequirements && !hasCriteria) {
      errors.push('Vínculo obrigatório ausente: Requisitos Funcionais sem Critérios de Aceite.');
    }

    // 4. Dependencies check
    if (content.includes('dependências')) {
      const dependencySection = content.split('dependências')[1]?.split('##')[0] || '';
      if (
        dependencySection &&
        !dependencySection.includes('owner') &&
        !dependencySection.includes('impacto')
      ) {
        errors.push('Dependências incompletas: Campos "owner" ou "impacto/risco" ausentes.');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Analyzes coverage by comparing original PM input vs summarized PRD.
   * Detects omissions by category.
   */
  static analyzeCoverage(original: string, summarized: string): CoverageAnalysisResult {
    const omittedItems: {
      category: string;
      item: string;
      criticality: 'HIGH' | 'MEDIUM' | 'LOW';
    }[] = [];

    // Pilot implementation: simple keyword/sentence extraction comparison
    const categories = [
      { name: 'Negócio', keywords: ['valor', 'roi', 'métrica', 'objetivo'] },
      { name: 'Regra', keywords: ['regra', 'validação', 'fluxo', 'limite'] },
      { name: 'Técnico', keywords: ['api', 'banco', 'endpoint', 'latência'] },
    ];

    const originalLower = original.toLowerCase();
    const summarizedLower = summarized.toLowerCase();

    for (const cat of categories) {
      for (const keyword of cat.keywords) {
        if (originalLower.includes(keyword) && !summarizedLower.includes(keyword)) {
          omittedItems.push({
            category: cat.name,
            item: `Menção a "${keyword}" encontrada no original mas omitida no resumido.`,
            criticality: keyword === 'valor' || keyword === 'regra' ? 'HIGH' : 'MEDIUM',
          });
        }
      }
    }

    const score = Math.max(0, 100 - omittedItems.length * 10);

    return {
      omittedItems,
      score,
      analyzedAt: new Date().toISOString(),
    };
  }

  /**
   * Generates a learning log based on accepted/rejected interactions.
   */
  static generateLearnings(interactions: RefinementInteraction[]): string[] {
    const learnings: string[] = [];

    const accepted = interactions.filter((i) => i.action === 'ACCEPT');
    const rejected = interactions.filter((i) => i.action === 'REJECT');

    if (accepted.length > 0) {
      learnings.push(
        `### Itens Adicionados/Corrigidos\n${accepted.map((i) => `- [${i.section}] ${i.itemKey}: ${i.justification}`).join('\n')}`,
      );
    }

    if (rejected.length > 0) {
      learnings.push(
        `### Itens Desconsiderados/Rejeitados\n${rejected.map((i) => `- [${i.section}] ${i.itemKey}: ${i.justification}`).join('\n')}`,
      );
    }

    return learnings;
  }
}
