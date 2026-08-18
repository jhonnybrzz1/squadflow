/**
 * Demanda 10078 — rotas do módulo de retrospectiva automatizada.
 * Atrás da flag `retrospectiveModuleEnabled` (default OFF): 404 até validar.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, AppError } from '../middleware/error-handler';
import { retrospectiveService } from '../services/retrospective-service';
import { featureFlags } from '../services/feature-flags';
import { retroActionsService, type RetroSnapshot } from '../services/retro-actions-service';
import { demandRepository } from '../repositories/demand-repository';

const router = Router();

function requireFlagEnabled(): void {
  if (!featureFlags.getFlags().retrospectiveModuleEnabled) {
    throw new AppError(
      'Módulo de retrospectiva desabilitado',
      404,
      'RETROSPECTIVE_MODULE_DISABLED',
    );
  }
}

const startBodySchema = z.object({
  periodStart: z.string().min(1),
  periodEnd: z.string().min(1),
});

const sessionParamsSchema = z.object({
  id: z.string().min(1),
});

router.post(
  '/api/retrospective',
  asyncHandler(async (req: Request, res: Response) => {
    requireFlagEnabled();
    const { periodStart, periodEnd } = startBodySchema.parse(req.body);
    const { id } = await retrospectiveService.start(periodStart, periodEnd);
    res.status(202).json({ id });
  }),
);

router.get(
  '/api/retrospective',
  asyncHandler(async (_req: Request, res: Response) => {
    requireFlagEnabled();
    const sessions = await retrospectiveService.listAll();
    res.json({ sessions });
  }),
);

router.get(
  '/api/retrospective/:id',
  asyncHandler(async (req: Request, res: Response) => {
    requireFlagEnabled();
    const { id } = sessionParamsSchema.parse(req.params);
    const session = await retrospectiveService.findById(id);
    if (!session) {
      throw new AppError('Sessão de retrospectiva não encontrada', 404, 'NOT_FOUND');
    }
    res.json(session);
  }),
);

const updateMessagesBodySchema = z.object({
  messages: z.array(
    z.object({
      agent: z.string(),
      content: z.string(),
      createdAt: z.string(),
    }),
  ),
});

router.put(
  '/api/retrospective/:id/messages',
  asyncHandler(async (req: Request, res: Response) => {
    requireFlagEnabled();
    const { id } = sessionParamsSchema.parse(req.params);
    const { messages } = updateMessagesBodySchema.parse(req.body);
    try {
      const updated = await retrospectiveService.updateMessages(id, messages);
      res.status(200).json(updated);
    } catch (_err) {
      throw new AppError('Sessão de retrospectiva não encontrada', 404, 'NOT_FOUND');
    }
  }),
);

router.patch(
  '/api/retrospective/:id/pause',
  asyncHandler(async (req: Request, res: Response) => {
    requireFlagEnabled();
    const { id } = sessionParamsSchema.parse(req.params);
    await retrospectiveService.pause(id);
    res.json({ ok: true });
  }),
);

router.patch(
  '/api/retrospective/:id/resume',
  asyncHandler(async (req: Request, res: Response) => {
    requireFlagEnabled();
    const { id } = sessionParamsSchema.parse(req.params);
    await retrospectiveService.resume(id);
    res.json({ ok: true });
  }),
);

router.delete(
  '/api/retrospective/:id',
  asyncHandler(async (req: Request, res: Response) => {
    requireFlagEnabled();
    const { id } = sessionParamsSchema.parse(req.params);
    await retrospectiveService.cancel(id);
    res.json({ ok: true });
  }),
);

/**
 * Demanda 10092 — evidência de execução + ciclo de ações.
 *
 * Estas rotas NÃO ficam atrás de `retrospectiveModuleEnabled`: elas só agregam
 * dados já existentes (nenhuma chamada de LLM), então não têm o custo que
 * justificava a flag da 10078.
 */

const generateBodySchema = z.object({
  periodStart: z.string().min(1),
  periodEnd: z.string().min(1),
});

/** Snapshot de evidência: agrega o período a partir das demandas reais. */
async function buildSnapshot(periodStart: string, periodEnd: string): Promise<RetroSnapshot> {
  const startMs = new Date(periodStart).getTime();
  const endMs = new Date(`${periodEnd}T23:59:59.999Z`).getTime();

  const all = await demandRepository.findAll();
  const inPeriod = all.filter((d) => {
    const created = d.createdAt ? new Date(d.createdAt).getTime() : NaN;
    return Number.isFinite(created) && created >= startMs && created <= endMs;
  });

  const sum = (pick: (d: (typeof inPeriod)[number]) => unknown): number =>
    inPeriod.reduce((acc, d) => {
      const v = pick(d);
      return acc + (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    }, 0);

  return {
    periodStart,
    periodEnd,
    demands: inPeriod.length,
    completed: inPeriod.filter((d) => d.status === 'completed').length,
    failed: inPeriod.filter((d) => d.status === 'error' || d.status === 'stopped').length,
    tokens: sum((d) => d.promptTokens) + sum((d) => d.completionTokens),
    cost: sum((d) => d.custoEstimado),
  };
}

router.post(
  '/api/retrospective/generate',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = generateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'periodStart e periodEnd são obrigatórios' });
      return;
    }
    const snapshot = await buildSnapshot(parsed.data.periodStart, parsed.data.periodEnd);
    const { id } = await retroActionsService.createRetrospective(snapshot);
    // Retro nova nunca tem ações — lista vazia é resposta válida, não erro.
    res.status(201).json({ id, snapshot, actions: [] });
  }),
);

const actionBodySchema = z.object({
  description: z.string().trim().min(1).max(500),
  metricKey: z.string().trim().min(1).max(60),
  owner: z.string().trim().max(120).optional(),
  successCriteria: z.string().trim().max(500).optional(),
});

const updateActionBodySchema = z.object({
  metricAfter: z.number().finite(),
});

router.post(
  '/api/retrospective/:retroId/actions',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = actionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'description e metricKey são obrigatórios' });
      return;
    }
    // metric_before sai do snapshot, não do payload.
    const created = await retroActionsService.createAction(req.params.retroId, parsed.data);
    if (!created) {
      throw new AppError('Retrospectiva não encontrada', 404, 'NOT_FOUND');
    }
    res.status(201).json(created);
  }),
);

router.get(
  '/api/retrospective/:retroId/actions',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ actions: await retroActionsService.listActions(req.params.retroId) });
  }),
);

router.patch(
  '/api/retrospective/:retroId/actions/:actionId',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = updateActionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'metricAfter deve ser um número finito' });
      return;
    }
    const updated = await retroActionsService.setMetricAfter(
      req.params.retroId,
      req.params.actionId,
      parsed.data.metricAfter,
    );
    if (!updated) {
      throw new AppError('Ação não encontrada', 404, 'NOT_FOUND');
    }
    res.json(updated);
  }),
);

export default router;
