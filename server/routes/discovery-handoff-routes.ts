/**
 * Demanda 10196 — Handoff Discovery → Refinement.
 *
 * POST /api/discovery/compile-hist
 * Recebe o histórico de mensagens de uma sessão Discovery + metadados do framework,
 * chama o LLM para produzir um resumo estruturado em JSON e retorna para o cliente
 * transferir via sessionStorage para a tela de Refinamento (/).
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, AppError } from '../middleware/error-handler';
import { openAIService } from '../services/openai-ai';
import { logger } from '../utils/logger';

const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

const compileBodySchema = z.object({
  messages: z.array(chatMessageSchema).max(100),
  framework: z.object({
    slug: z.string(),
    name: z.string(),
  }),
  sessionId: z.string().optional(),
});

const summarySchema = z.object({
  problema_central: z.string().min(1),
  framework_aplicado: z.string().min(1),
  proximo_passo: z.string().min(1),
  contexto: z.string().min(1),
});

const MAX_MESSAGES = 10;
const MIN_SUMMARY_LENGTH = 50;

const SYSTEM_PROMPT = `Você é um assistente de product management. Receba o histórico de uma conversa de Discovery conduzida por um framework de produto e resuma-a em um JSON estruturado e conciso em português brasileiro.

O JSON deve conter EXATAMENTE estas chaves:
- problema_central: o problema principal identificado na conversa (1-2 frases)
- framework_aplicado: nome do framework utilizado e como ele foi aplicado (1-2 frases)
- proximo_passo: próxima ação recomendada para o time de produto/tecnologia (1-2 frases)
- contexto: contexto essencial capturado durante o Discovery (2-4 frases)

Regras:
- Responda APENAS com o objeto JSON, sem markdown, sem explicações extras.
- Não invente informações que não estejam no histórico.
- Seja objetivo e preserve a metodologia do framework.`;

function buildUserPrompt(
  messages: { role: 'user' | 'assistant'; content: string }[],
  framework: { slug: string; name: string },
): string {
  const recent = messages.slice(-MAX_MESSAGES);
  const historyText = recent
    .map((m) => `${m.role === 'user' ? 'Pessoa' : 'Agente PM'}: ${m.content}`)
    .join('\n\n');

  return `Framework: ${framework.name} (slug: ${framework.slug})

Histórico da conversa (últimas ${recent.length} mensagens):

${historyText}

Gere o JSON estruturado conforme instruções.`;
}

function validateSummary(
  value: unknown,
): { valid: false; reason: string } | { valid: true; summary: z.infer<typeof summarySchema> } {
  const parsed = summarySchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.path.join('.') || 'value');
    return {
      valid: false,
      reason: `Campos obrigatórios ausentes ou inválidos: ${issues.join(', ')}`,
    };
  }

  const fullText = Object.values(parsed.data).join(' ');
  if (fullText.length < MIN_SUMMARY_LENGTH) {
    return {
      valid: false,
      reason: `Resumo muito curto (${fullText.length} caracteres; mínimo ${MIN_SUMMARY_LENGTH})`,
    };
  }

  if (!parsed.data.problema_central.trim() || !parsed.data.proximo_passo.trim()) {
    return { valid: false, reason: "'problema_central' e 'proximo_passo' não podem estar vazios" };
  }

  return { valid: true, summary: parsed.data };
}

const router = Router();

router.post(
  '/api/discovery/compile-hist',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = compileBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('Corpo da requisição inválido', 400, 'INVALID_BODY');
    }

    const { messages, framework, sessionId } = parsed.data;

    if (messages.length === 0) {
      throw new AppError('Histórico vazio', 400, 'EMPTY_HISTORY');
    }

    const wasTruncated = messages.length > MAX_MESSAGES;

    try {
      const raw = await openAIService.generateJSONResponse<Record<string, unknown>>(
        SYSTEM_PROMPT,
        buildUserPrompt(messages, framework),
        {
          agentName: 'pm_discovery',
          operation: 'discovery:compile-hist',
          temperature: 0.3,
          maxTokens: 1200,
          schema: summarySchema,
        },
      );

      const validation = validateSummary(raw);
      if (!validation.valid) {
        logger.warn('Discovery compile-hist: resumo inválido na primeira tentativa', {
          context: { reason: validation.reason, sessionId },
        });

        // Retry 1x em caso de falha de estrutura
        const retryRaw = await openAIService.generateJSONResponse<Record<string, unknown>>(
          `${SYSTEM_PROMPT}\n\nAtenção: a resposta anterior foi rejeitada porque ${validation.reason}. Corrija e responda apenas JSON válido.`,
          buildUserPrompt(messages, framework),
          {
            agentName: 'pm_discovery',
            operation: 'discovery:compile-hist:retry',
            temperature: 0.2,
            maxTokens: 1200,
            schema: summarySchema,
          },
        );

        const retryValidation = validateSummary(retryRaw);
        if (!retryValidation.valid) {
          throw new AppError(
            `Falha ao estruturar resumo: ${retryValidation.reason}`,
            422,
            'STRUCTURE_ERROR',
          );
        }

        res.json({
          summary: retryValidation.summary,
          framework,
          sessionId,
          truncated: wasTruncated,
          retried: true,
        });
        return;
      }

      res.json({
        summary: validation.summary,
        framework,
        sessionId,
        truncated: wasTruncated,
        retried: false,
      });
    } catch (error) {
      logger.error('Discovery compile-hist error', {
        context: { error: error instanceof Error ? error.message : String(error), sessionId },
      });
      throw error;
    }
  }),
);

export default router;
