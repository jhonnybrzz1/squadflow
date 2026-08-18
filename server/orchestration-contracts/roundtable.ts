/**
 * Contratos da mesa redonda e do output de refinamento.
 *
 * Extraídos de services/ai-squad/roundtable-orchestrator.ts e de
 * cognitive-core/roundtable-agents.ts para permitir que cognitive-core e
 * ai-squad dependam deles sem ciclo.
 */

import { z } from 'zod';
import { logger } from '../utils/logger';
import { DEFAULT_ROUNDTABLE_AGENTS as _DEFAULT_ROUNDTABLE_AGENTS } from '../../shared/agent-roles';

/**
 * Fonte única da squad canônica da mesa redonda (spec 10058).
 *
 * Squad de 7 agentes. Ordem: `product_owner` abre; `anti_overengineering`
 * fecha (SUBTRAI do digest completo).
 *
 * Re-exportado de shared/agent-roles.ts para manter uma única fonte da verdade.
 */
export const DEFAULT_ROUNDTABLE_AGENTS = _DEFAULT_ROUNDTABLE_AGENTS;

/** Nível de refinamento da mesa redonda (1–3). */
export type RefinementLevel = 1 | 2 | 3;

export const RedTeamFalhaSchema = z.object({
  trecho: z.string(),
  tipo: z.string(),
  severidade: z.enum(['ALTA', 'BAIXA']),
  sugestao: z.string(),
});

export const RedTeamOutputSchema = z.object({
  falhas: z.array(RedTeamFalhaSchema),
});

export const JudgeConfirmedFailureSchema = z.object({
  trecho: z.string(),
  tipo: z.string(),
  severidade: z.enum(['ALTA', 'BAIXA']),
  sugestao: z.string(),
  motivo: z.string(),
});

export const JudgeOutputSchema = z.object({
  falhas_confirmadas: z.array(JudgeConfirmedFailureSchema),
});

export const RefinementOutputSchema = z.object({
  problema: z.string().min(1),
  objetivo: z.string().min(1),
  escopo: z.string().min(1),
  criterios_de_aceite: z.array(z.string()).min(1),
  riscos: z.array(z.string()),
  dependencias: z.array(z.string()),
  divergencias: z.array(z.string()),
  consolidacao: z.string(),
});

export type RefinementOutput = z.infer<typeof RefinementOutputSchema>;

export function buildConsolidationSystemPrompt(typeRequirements?: string[]): string {
  const typeReqsBlock =
    typeRequirements && typeRequirements.length > 0
      ? `\n\nAs seguintes secoes sao OBRIGATORIAS no PRD/consolidacao final e DEVEM estar refletidas no texto (problema, objetivo, escopo, criterios_de_aceite, riscos, dependencias e/ou sintese):\n${typeRequirements.map((r) => `- ${r}`).join('\n')}`
      : '';
  return `Você é o orquestrador de uma mesa redonda de refinamento de produto. Com base no histórico completo do debate entre os agentes, gere uma consolidação estruturada em JSON.${typeReqsBlock}

|--- REGRA DE INTEGRIDADE NUMÉRICA (obrigatória) ---
|- NUNCA invente números: percentuais, valores monetários, ROI, prazos, baselines ou taxas. Só inclua um número se ele veio (a) do input do usuário, (b) de evidência verificada do repositório, ou (c) de dado histórico real.
|- Quando o dado não existir, escreva exatamente: 'A MEDIR — sem baseline'. Para metas relativas, escreva: 'Definir após coletar baseline'.
|- É PROIBIDO preencher a tabela de métricas com números só para completá-la. Uma célula honesta 'A MEDIR' vale mais que um número inventado.
|- ROI/custo: só calcule se tiver os dois lados (custo e ganho) com fonte. Sem fonte, escreva 'Estimativa pendente de dados'.

IMPORTANTE: Responda APENAS com JSON válido no formato especificado. Não adicione markdown, não use backticks.`;
}

export function buildConsolidationUserPrompt(
  demandTitle: string,
  demandDescription: string,
  history: string[],
  divergences: string[],
  typeRequirements?: string[],
): string {
  const divsText = divergences.join('\n') || 'Nenhuma';
  const typeReqsBlock =
    typeRequirements && typeRequirements.length > 0
      ? `\n\n=== SECOES OBRIGATORIAS ===\nA consolidação final deve cobrir explicitamente os seguintes topicos:\n${typeRequirements.map((r) => `- ${r}`).join('\n')}`
      : '';
  return `Demanda original:\nTítulo: ${demandTitle}\nDescrição: ${demandDescription}\n\nHistórico do debate:\n${history.join(
    '\n\n',
  )}\n\nDivergências identificadas:\n${divsText}${typeReqsBlock}\n\nGere a consolidação no seguinte formato JSON:\n{\n  "problema": "string",\n  "objetivo": "string",\n  "escopo": "string",\n  "criterios_de_aceite": ["string"],\n  "riscos": ["string"],\n  "dependencias": ["string"],\n  "divergencias": ["string"],\n  "consolidacao": "string (resumo executivo de 2-3 parágrafos)"\n}`;
}

export function extractJsonObject(raw: string): unknown {
  const withoutFences = raw
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/g, '')
    .trim();
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? withoutFences.slice(start, end + 1) : withoutFences;
  try {
    return JSON.parse(candidate);
  } catch (err) {
    logger.warn('[extractJsonObject] JSON inválido retornado pelo LLM', {
      error: err instanceof Error ? err : undefined,
      context: { rawPreview: candidate.slice(0, 200) },
    });
    throw new Error('Invalid JSON returned by LLM', {
      cause: err instanceof Error ? err : undefined,
    });
  }
}

export interface RoundtableConfig {
  agentIds: string[];
  maxRounds: number;
  refinementLevel?: RefinementLevel;
}

export interface RoundtableRoundResult {
  round: number;
  contributions: Record<string, string>;
  divergences: string[];
}

import type { SquadGraph } from './squad';

export interface RoundtableResult {
  rounds: RoundtableRoundResult[];
  consolidation: RefinementOutput;
  totalDivergences: number;
  agentsFailed: string[];
  graph?: SquadGraph;
  escalations?: Array<{ agent: string; round: number; reason: string }>;
}

export interface RoundtableRuntimeContext {
  runId?: string;
  pipelineId: string;
  skipExtraction?: boolean;
}
