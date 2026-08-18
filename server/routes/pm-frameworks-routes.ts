/**
 * Demanda 10091 — API interna do catálogo de frameworks de Discovery.
 *   GET /api/pm-frameworks        — lista (sem content, payload leve)
 *   GET /api/pm-frameworks/:slug  — framework completo (content markdown)
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, AppError } from '../middleware/error-handler';
import { pmFrameworksService } from '../services/pm-frameworks-service';
import { AgentFactory } from '../services/ai-squad/AgentFactory';
import { openAIService } from '../services/openai-ai';

/** Trecho do framework injetado no contexto — o markdown inteiro estoura o prompt. */
const FRAMEWORK_CONTEXT_LIMIT = 8000;

const chatBodySchema = z.object({
  message: z.string().trim().min(1).max(4000),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }))
    .max(20)
    .optional(),
});

const router = Router();

router.get(
  '/api/pm-frameworks',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ frameworks: await pmFrameworksService.list() });
  }),
);

router.get(
  '/api/pm-frameworks/:slug',
  asyncHandler(async (req: Request, res: Response) => {
    const framework = await pmFrameworksService.findBySlug(req.params.slug);
    if (!framework) {
      throw new AppError(`Framework '${req.params.slug}' não encontrado`, 404, 'NOT_FOUND');
    }
    res.json(framework);
  }),
);

/**
 * Demanda 10091 — conversa com o agente PM usando o framework como método.
 * O markdown do framework é injetado no system prompt (contexto), não como
 * instrução do usuário: o agente segue o método, não obedece o documento.
 */
router.post(
  '/api/pm-frameworks/:slug/chat',
  asyncHandler(async (req: Request, res: Response) => {
    const framework = await pmFrameworksService.findBySlug(req.params.slug);
    if (!framework) {
      throw new AppError(`Framework '${req.params.slug}' não encontrado`, 404, 'NOT_FOUND');
    }

    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Mensagem inválida', code: 'INVALID_MESSAGE' });
      return;
    }

    const { agentConfigs } = new AgentFactory().loadConfigurations();
    const config = agentConfigs['pm_discovery'];
    if (!config) {
      throw new AppError('Agente pm_discovery não configurado', 500, 'AGENT_NOT_CONFIGURED');
    }

    const frameworkContext = framework.content.slice(0, FRAMEWORK_CONTEXT_LIMIT);
    const systemPrompt = `${config.system_prompt}

# FRAMEWORK CARREGADO: ${framework.name}
${frameworkContext}`;

    const history = (parsed.data.history ?? [])
      .map((m) => `${m.role === 'user' ? 'Pessoa' : 'Você'}: ${m.content}`)
      .join('\n');
    const userPrompt = history ? `${history}\nPessoa: ${parsed.data.message}` : parsed.data.message;

    const reply = await openAIService.generateChatCompletion(systemPrompt, userPrompt, {
      agentName: 'pm_discovery',
      operation: 'discovery:chat',
      model: config.model,
      modelFallback: config.model_fallback,
      temperature: config.temperature,
      maxTokens: config.max_tokens,
      cache: false,
      // Conteúdo interno (framework versionado + pergunta da própria pessoa):
      // um soluço do classificador não deve derrubar a conversa.
      failOpenOnError: true,
    });

    res.json({ reply, framework: { slug: framework.slug, name: framework.name } });
  }),
);

export default router;
