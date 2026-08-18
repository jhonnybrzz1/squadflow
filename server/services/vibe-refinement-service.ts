/**
 * Demanda #10358 T3 — refinamento por IA simplificado (prompt livre).
 * Demanda #10365 T5 — injeta schema de banco do usuário como contexto adicional.
 *
 * Reaproveita `openAIService` (mesma infra de cache/guardrails/custo/telemetria
 * do resto do produto). O que muda é só o TEMPLATE de prompt — concatena
 * descrição livre + stack + tipo de projeto + contexto de repo + schema de banco
 * — conforme validado pelo tech_lead no PRD (custo técnico desprezível, zero
 * mudança de infra).
 */
import { z } from 'zod';
import { openAIService } from './openai-ai';
import { AppError } from '../middleware/error-handler';
import { dbSchemaService } from './db-schema-service';
import { logger } from '../utils/logger';

export interface VibeRefinementRequest {
  prompt: string;
  stack?: string;
  projectType?: string;
  /** T6: contexto opcional do repositório GitHub conectado (nome do repo). */
  repoContext?: string;
  /** #10365 T5: ID opcional de conexão de banco para injetar schema. */
  dbConnectionId?: number;
  /** #10365 T5: userId para buscar a conexão de banco. */
  userId?: number;
}

const refinementResponseSchema = z.object({
  refinedDescription: z.string().min(1),
  suggestedTasks: z.array(z.string().min(1)).min(1),
  estimatedComplexity: z.string().min(1),
});

export type VibeRefinementResult = z.infer<typeof refinementResponseSchema>;

const SYSTEM_PROMPT = `Você é um assistente de refinamento de produto para "Vibe Coders" —
desenvolvedores solo que usam IA para prototipar rapidamente. Dado um pedido em texto livre,
devolva SOMENTE um JSON (sem markdown, sem texto fora do JSON) com este formato exato:
{
  "refinedDescription": string (descrição clara e estruturada do que construir),
  "suggestedTasks": string[] (3 a 6 passos concretos e ordenados),
  "estimatedComplexity": string (uma palavra: "baixa", "média" ou "alta")
}`;

function buildUserPrompt(input: VibeRefinementRequest, dbSchemaContext?: string): string {
  const parts = [`Descrição: ${input.prompt.trim()}`];
  if (input.stack?.trim()) parts.push(`Stack informada: ${input.stack.trim()}`);
  if (input.projectType?.trim()) parts.push(`Tipo de projeto: ${input.projectType.trim()}`);
  if (input.repoContext?.trim()) parts.push(`Repositório conectado: ${input.repoContext.trim()}`);
  if (dbSchemaContext?.trim()) parts.push(`Schema do banco de dados:\n${dbSchemaContext}`);
  return parts.join('\n');
}

/** Formata schema como markdown compacto para economizar tokens. */
function formatSchemaAsMarkdown(schema: {
  tables: { name: string; columns: { name: string; type: string; nullable: boolean }[] }[];
}): string {
  const lines: string[] = [];
  for (const table of schema.tables) {
    const cols = table.columns
      .map((c) => `${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`)
      .join(', ');
    lines.push(`**${table.name}** (${cols})`);
  }
  return lines.join('\n');
}

class VibeRefinementService {
  async refine(input: VibeRefinementRequest): Promise<VibeRefinementResult> {
    // T5: se dbConnectionId fornecido, busca schema e injeta no prompt.
    // Fallback gracioso: se schema falhar, prossegue sem ele.
    let dbSchemaContext: string | undefined;
    if (input.dbConnectionId && input.userId) {
      try {
        const schema = await dbSchemaService.getSchema(input.userId, input.dbConnectionId);
        if (schema.tables.length > 0) {
          dbSchemaContext = formatSchemaAsMarkdown(schema);
          if (schema.truncated) {
            dbSchemaContext += '\n(Nota: schema truncado para top 50 tabelas por relevância)';
          }
        }
      } catch (error) {
        logger.warn('Falha ao obter schema de banco para refinamento — prosseguindo sem schema', {
          error: error instanceof Error ? error : undefined,
          context: { dbConnectionId: input.dbConnectionId },
        });
      }
    }

    const userPrompt = buildUserPrompt(input, dbSchemaContext);

    const raw = await openAIService.generateChatCompletion(SYSTEM_PROMPT, userPrompt, {
      operation: 'vibe_refinement',
      taskType: 'json',
      responseFormat: 'json_object',
      cache: false,
    });

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new AppError(
        'A IA retornou uma resposta em formato inválido. Tente novamente.',
        502,
        'REFINEMENT_INVALID_JSON',
      );
    }

    const result = refinementResponseSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new AppError(
        'A IA retornou uma resposta fora do formato esperado. Tente novamente.',
        502,
        'REFINEMENT_INVALID_SHAPE',
        { issues: result.error.issues },
      );
    }
    return result.data;
  }
}

export const vibeRefinementService = new VibeRefinementService();
