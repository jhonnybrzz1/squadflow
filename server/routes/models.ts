/**
 * Demanda 10082 (F3) — visibilidade do modelo ativo por agente.
 *
 * Somente-leitura, sem autenticação (expõe apenas alias/modelId/provider, não
 * segredos). Duas rotas:
 *   • GET /api/models/overview            — batch: modelo de cada agente da squad.
 *   • GET /api/models/active?agent_id=<id> — unitário: modelo ativo de um agente.
 *
 * Fonte: configs da squad (AgentFactory) + resolução concreta via modelRegistry.
 * Se o registry estiver indisponível, cada agente cai em fail-open (retorna a
 * config declarada sem o modelId resolvido) — a tela nunca quebra por isso.
 */
import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../middleware/error-handler';
import { AgentFactory } from '../services/ai-squad/AgentFactory';
import { modelRegistry } from '../services/model-registry';

const router = Router();

interface AgentModelView {
  agentId: string;
  model: string | null;
  modelFallback: string | null;
  active: {
    modelId: string;
    provider: string;
    source: string; // 'memory-cache' | 'database' | 'static-fallback'
    usingFallback: boolean;
  } | null;
}

async function buildAgentModelView(agentId: string, model?: string, fallback?: string) {
  const view: AgentModelView = {
    agentId,
    model: model ?? null,
    modelFallback: fallback ?? null,
    active: null,
  };
  if (!model) return view;
  try {
    const resolved = await modelRegistry.resolve(model);
    view.active = {
      modelId: resolved.modelId,
      provider: resolved.provider,
      source: resolved.source,
      // static-fallback => o alias não resolveu para o modelo original.
      usingFallback: resolved.source === 'static-fallback',
    };
  } catch (_) {
    // Fail-open: registry indisponível não deve derrubar a listagem.
  }
  return view;
}

router.get(
  '/api/models/overview',
  asyncHandler(async (_req: Request, res: Response) => {
    const { agentConfigs } = new AgentFactory().loadConfigurations();
    const agents = await Promise.all(
      Object.entries(agentConfigs).map(([agentId, cfg]) =>
        buildAgentModelView(agentId, cfg.model, cfg.model_fallback),
      ),
    );
    res.json({ agents });
  }),
);

router.get(
  '/api/models/active',
  asyncHandler(async (req: Request, res: Response) => {
    const agentId = typeof req.query.agent_id === 'string' ? req.query.agent_id : '';
    if (!agentId) {
      res.status(400).json({ error: 'agent_id é obrigatório' });
      return;
    }
    const { agentConfigs } = new AgentFactory().loadConfigurations();
    const cfg = agentConfigs[agentId];
    if (!cfg) {
      res.status(404).json({ error: `Agente '${agentId}' não encontrado` });
      return;
    }
    res.json(await buildAgentModelView(agentId, cfg.model, cfg.model_fallback));
  }),
);

export default router;
