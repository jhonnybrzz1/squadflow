import { TYPE_CONTRACTS, TypeAdherenceResult, RefinementType } from '@shared/schema';

/**
 * Validates if a refinement content adheres to the expected type contract
 */
export class TypeContractValidator {
  /**
   * Validates content against the specified refinement type contract
   */
  validateTypeAdherence(content: string, refinementType: RefinementType): TypeAdherenceResult {
    // Handle legacy refinements without type
    if (!refinementType) {
      return {
        isAdherent: true,
        type: null,
        sectionsFound: [],
        sectionsRequired: 0,
        sectionsMet: 0,
        score: 100,
        feedback:
          'Refinamento legado sem tipo definido. Considere selecionar um tipo para melhor estruturação.',
      };
    }

    const contract = TYPE_CONTRACTS[refinementType];
    if (!contract) {
      return {
        isAdherent: false,
        type: refinementType,
        sectionsFound: [],
        sectionsRequired: 0,
        sectionsMet: 0,
        score: 0,
        feedback: `Tipo de refinamento "${refinementType}" não reconhecido.`,
      };
    }

    // Extract markdown headings (lines starting with #, ##, ###, etc.)
    const headingLines = content
      .split('\n')
      .filter((line) => /^#{1,4}\s+/.test(line.trim()))
      .map((line) => line.toLowerCase());

    // Find which required sections are present as actual headings
    const sectionsFound = contract.requiredSections.filter((section) => {
      const sectionLower = section.toLowerCase();
      // Check if any heading contains this section keyword
      return headingLines.some((heading) => heading.includes(sectionLower));
    });

    const sectionsMet = sectionsFound.length;
    const sectionsRequired = contract.minSectionsRequired;
    const totalSections = contract.requiredSections.length;
    const isAdherent = sectionsMet >= sectionsRequired;
    // Score calculado contra total de seções do contrato, não apenas o mínimo
    const score = Math.round((sectionsMet / totalSections) * 100);

    // Generate feedback based on adherence
    let feedback: string;
    if (isAdherent) {
      feedback =
        `Refinamento atende ao contrato ${refinementType === 'technical' ? 'Técnico' : 'de Negócios'}. ` +
        `Seções identificadas: ${sectionsFound.join(', ')}.`;
    } else {
      const missingSuggestions = contract.requiredSections
        .filter((s) => !sectionsFound.includes(s))
        .slice(0, 3)
        .join(', ');

      feedback =
        refinementType === 'technical'
          ? `Faltou estrutura técnica. Considere adicionar seções: ${missingSuggestions}.`
          : `Faltou estrutura de negócios. Considere adicionar seções: ${missingSuggestions}.`;
    }

    return {
      isAdherent,
      type: refinementType,
      sectionsFound,
      sectionsRequired,
      sectionsMet,
      score,
      feedback,
    };
  }

  /**
   * Gets the contract description for a refinement type
   */
  getContractDescription(refinementType: RefinementType): string {
    if (!refinementType) {
      return 'Nenhum tipo de refinamento selecionado.';
    }

    const contract = TYPE_CONTRACTS[refinementType];
    if (!contract) {
      return 'Tipo de refinamento não reconhecido.';
    }

    return contract.description;
  }

  /**
   * Gets guidance for what the user should look for in the refinement
   */
  getTypeGuidance(refinementType: RefinementType): {
    lookFor: string[];
    description: string;
  } {
    if (!refinementType) {
      return {
        lookFor: [],
        description: 'Sem tipo definido - refinamento legado',
      };
    }

    if (refinementType === 'technical') {
      return {
        lookFor: [
          'Arquitetura ou componentes envolvidos',
          'Dependências e integrações',
          'Trade-offs e decisões técnicas',
          'Riscos técnicos e mitigação',
        ],
        description: 'Refinamento Técnico: foco em estrutura técnica e decisões de engenharia',
      };
    }

    return {
      lookFor: [
        'Objetivo e problema resolvido',
        'Benefício e valor gerado',
        'Impacto e métricas de sucesso',
        'Prioridade e próximos passos',
      ],
      description: 'Refinamento de Negócios: foco em objetivo, valor e impacto',
    };
  }
}

// Export singleton instance
export const typeContractValidator = new TypeContractValidator();
