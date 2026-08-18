/**
 * Demanda 10025 — ArtifactAdapter.
 *
 * Normaliza a saída do orquestrador unificado (RefinementOutput da mesa
 * redonda) para (a) o artefato JSON do contrato `POST /api/refinement/unified`
 * e (b) o markdown de PRD no MESMO formato do pipeline existente
 * (`buildRoundtablePRDContent`), garantindo SC-002 (mesmo formato/validação).
 *
 * Se a normalização falhar, o fallback é um template sequencial mínimo com
 * `adapterFallback: true` (FR-007) — nunca lança para o caller.
 */

import { RefinementOutputSchema, type RefinementOutput } from '../orchestration-contracts';
import { buildRoundtablePRDContent } from './ai-squad/roundtable-prd';
import { logger } from '../utils/logger';

export interface UnifiedArtifact {
  objetivo: string;
  criteriosAceite: string[];
  riscos: string[];
  dependencias: string[];
  escopo: string;
  sintese: string;
}

export interface AdaptedArtifact {
  artifact: UnifiedArtifact;
  /** PRD no formato padrão do pipeline (para saveDocument/validação). */
  prdMarkdown: string;
  adapterFallback: boolean;
}

export interface AdapterDemandContext {
  demandTitle: string;
  demandType?: string;
  demandDescription?: string;
  refinementType?: 'technical' | 'business' | null;
}

/** Template mínimo usado quando a saída do orquestrador não é normalizável. */
export function buildSequentialTemplateArtifact(
  context: AdapterDemandContext,
  prdContent?: string,
): UnifiedArtifact {
  return {
    objetivo: `Refinar e implementar: ${context.demandTitle}`,
    criteriosAceite: [
      'Given a demanda descrita, When o refinamento é concluído, Then o PRD cobre o pedido original',
    ],
    riscos: ['Artefato gerado pelo caminho seguro — revisar cobertura manualmente'],
    dependencias: [],
    escopo: context.demandDescription?.slice(0, 500) ?? context.demandTitle,
    sintese:
      prdContent?.slice(0, 1000) ??
      'Refinamento concluído pelo caminho sequencial (fallback controlado).',
  };
}

export class ArtifactAdapter {
  /**
   * Normaliza a consolidação do debate para o artefato do contrato.
   * Nunca lança: em erro de validação/normalização retorna o template
   * sequencial com `adapterFallback: true`.
   */
  adapt(rawOutput: unknown, context: AdapterDemandContext): AdaptedArtifact {
    try {
      const output: RefinementOutput = RefinementOutputSchema.parse(rawOutput);

      const artifact: UnifiedArtifact = {
        objetivo: output.objetivo,
        criteriosAceite: output.criterios_de_aceite,
        riscos: output.riscos,
        dependencias: output.dependencias,
        escopo: output.escopo,
        sintese: output.consolidacao || output.problema,
      };

      const prdMarkdown = buildRoundtablePRDContent(output, {
        demandTitle: context.demandTitle,
        demandType: context.demandType,
        demandDescription: context.demandDescription,
        refinementType: context.refinementType ?? undefined,
      });

      return { artifact, prdMarkdown, adapterFallback: false };
    } catch (error) {
      logger.warn(
        'ArtifactAdapter: falha ao normalizar saída do orquestrador — template sequencial',
        {
          error: error instanceof Error ? error : undefined,
          context: { event: 'unified_refinement', phase: 'artifact', status: 'error' },
        },
      );
      const artifact = buildSequentialTemplateArtifact(context);
      return {
        artifact,
        prdMarkdown: [
          `# PRD - ${context.demandTitle}`,
          '',
          '## Objetivo',
          artifact.objetivo,
          '',
          '## Escopo',
          artifact.escopo,
          '',
          '## Critérios de Aceite',
          ...artifact.criteriosAceite.map((c) => `- ${c}`),
          '',
          '## Riscos',
          ...artifact.riscos.map((r) => `- ${r}`),
        ].join('\n'),
        adapterFallback: true,
      };
    }
  }
}

export const artifactAdapter = new ArtifactAdapter();
