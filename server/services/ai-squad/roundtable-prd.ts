import { type DemandType, getDemandTypeConfig, isDemandType } from '@shared/demand-types';
import { PromptParser } from './prompt-parser';

export interface RoundtableConsolidationContent {
  problema: string;
  objetivo: string;
  escopo: string;
  criterios_de_aceite: string[];
  riscos: string[];
  dependencias: string[];
  divergencias: string[];
  consolidacao: string;
}

export interface RoundtablePRDRound {
  round: number;
  contributions: Record<string, string>;
  divergences: string[];
}

export interface RoundtablePRDContext {
  demandTitle?: string;
  demandType?: string;
  demandDescription?: string;
  refinementType?: 'technical' | 'business' | null;
  rounds?: RoundtablePRDRound[];
  totalDivergences?: number;
  agentsFailed?: string[];
  typeRequirements?: string[];
}

function renderList(items: string[], fallback: string): string {
  const safeItems = items.map((item) => item.trim()).filter(Boolean);
  if (safeItems.length === 0) return `- ${fallback}`;
  return safeItems.map((item) => `- ${item}`).join('\n');
}

function renderTextBlock(value: string, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && !/verificar hist[oó]rico|a ser validado/i.test(trimmed) ? trimmed : fallback;
}

/**
 * Renders a compact digest of roundtable contributions.
 *
 * Instead of dumping every full agent message (which inflates the PRD to 70%+
 * evidence text), this produces one bullet per agent per round with only the
 * key insight extracted via PromptParser.extractKeyEvidence. Full content is
 * intentionally omitted — the roundtable chat history is persisted separately.
 */
function renderRoundtableEvidence(rounds: RoundtablePRDRound[] = []): string {
  if (rounds.length === 0) {
    return 'Nenhuma contribuicao detalhada foi persistida para esta mesa redonda.';
  }

  const lines: string[] = [];

  for (const round of rounds) {
    const contributions = Object.entries(round.contributions)
      .map(([agent, content]) => {
        const cleaned = content.trim();
        if (!cleaned) return '';
        const key = PromptParser.extractKeyEvidence(cleaned);
        return `- **${agent}**: ${key}`;
      })
      .filter(Boolean);

    if (contributions.length > 0) {
      lines.push(`**Rodada ${round.round}**\n${contributions.join('\n')}`);
    }

    const divergences = round.divergences.map((item) => item.trim()).filter(Boolean);
    if (divergences.length > 0) {
      lines.push(`*Divergências R${round.round}:* ${divergences.slice(0, 3).join(' | ')}`);
    }
  }

  return lines.join('\n\n');
}

function buildCodeAssistantPrompt(
  consolidation: RoundtableConsolidationContent,
  context: RoundtablePRDContext = {},
): string {
  const title = context.demandTitle?.trim() || 'Implementar demanda';
  const scope = renderTextBlock(consolidation.escopo, 'Implementar conforme especificado');
  const criteria = consolidation.criterios_de_aceite
    .map((c) => c.trim())
    .filter(Boolean)
    .join('; ');
  const risks = consolidation.riscos
    .map((r) => r.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join('; ');
  const deps = consolidation.dependencias
    .map((d) => d.trim())
    .filter(Boolean)
    .join('; ');

  return `Implemente: ${title}

ESCOPO:
${scope}

CRITERIOS DE ACEITE:
${criteria || 'Funcionalidade operacional e testavel'}

${risks ? `CUIDADOS:\n${risks}\n` : ''}${deps ? `DEPENDENCIAS:\n${deps}` : ''}

INSTRUCOES:
1. Analise o codigo existente antes de modificar
2. Faca alteracoes incrementais e testáveis
3. Mantenha compatibilidade com o stack atual
4. Documente decisoes tecnicas relevantes
5. REGRA DE INTEGRIDADE NUMÉRICA (obrigatória):
   - NUNCA invente números: percentuais, valores monetários, ROI, prazos, baselines ou taxas. Só inclua um número se ele veio (a) do input do usuário, (b) de evidência verificada do repositório, ou (c) de dado histórico real.
   - Quando o dado não existir, escreva exatamente: 'A MEDIR — sem baseline'. Para metas relativas, escreva: 'Definir após coletar baseline'.
   - É PROIBIDO preencher a tabela de métricas com números só para completá-la. Uma célula honesta 'A MEDIR' vale mais que um número inventado.
   - ROI/custo: só calcule se tiver os dois lados (custo e ganho) com fonte. Sem fonte, escreva 'Estimativa pendente de dados'.`;
}

export function buildRoundtablePRDContent(
  consolidation: RoundtableConsolidationContent,
  context: RoundtablePRDContext = {},
): string {
  const titleSuffix = context.demandTitle?.trim() ? ` - ${context.demandTitle.trim()}` : '';
  const safeType: DemandType = isDemandType(context.demandType || '')
    ? (context.demandType as DemandType)
    : 'discovery';
  const typeConfig = getDemandTypeConfig(safeType);

  const objective = renderTextBlock(
    consolidation.objetivo,
    'Consolidar decisao de produto em escopo e criterios verificaveis.',
  );
  const problem = renderTextBlock(
    consolidation.problema,
    'Oportunidade identificada pela mesa redonda.',
  );
  const scope = renderTextBlock(consolidation.escopo, 'Executar escopo consensuado pelos agentes.');
  const acceptanceCriteria = renderList(
    consolidation.criterios_de_aceite,
    'Validacao aprovada pelo PO e Tech Lead.',
  );
  const risks =
    consolidation.riscos.filter(Boolean).length > 0 ? renderList(consolidation.riscos, '') : null;
  const dependencies =
    consolidation.dependencias.filter(Boolean).length > 0
      ? renderList(consolidation.dependencias, '')
      : null;
  const divergences =
    consolidation.divergencias.filter(Boolean).length > 0
      ? renderList(consolidation.divergencias, '')
      : null;

  const typeRequirements =
    context.typeRequirements && context.typeRequirements.length > 0
      ? renderList(context.typeRequirements, '')
      : null;

  // Gerar prompt para assistente de código
  const codePrompt = buildCodeAssistantPrompt(consolidation, context);

  return `# Demanda${titleSuffix}

## Contrato
| Campo | Valor |
|-------|-------|
| Tipo | ${typeConfig.label} |
| Refinamento | ${context.refinementType === 'technical' ? 'Tecnico' : context.refinementType === 'business' ? 'Negocio' : 'Geral'} |
| Esforco Max | ${typeConfig.maxEffortDays} dias |
| ROI Min | ${typeConfig.minROI} |

## Objetivo
${objective}

## Problema
${problem}

## Escopo
${scope}

## Criterios de Aceite
${acceptanceCriteria}
${typeRequirements ? `\n## Secoes Obrigatorias\nO PRD deve incluir explicitamente as seguintes secoes derivadas do tipo de demanda:\n${typeRequirements}` : ''}
${risks ? `\n## Riscos\n${risks}` : ''}${dependencies ? `\n## Dependencias\n${dependencies}` : ''}${divergences ? `\n## Divergencias\n${divergences}` : ''}

## Sintese
${consolidation.consolidacao}

---

## Prompt Para Assistente de Codigo

Copie o bloco abaixo e envie para o Claude Code ou outro assistente:

\`\`\`
${codePrompt}
\`\`\`

---

<details>
<summary>Evidencias da Mesa Redonda (clique para expandir)</summary>

${renderRoundtableEvidence(context.rounds)}

**Saude:** ${context.rounds?.length || 0} ciclos, ${context.totalDivergences ?? consolidation.divergencias.length} divergencias
</details>`;
}
