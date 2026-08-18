import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, AppError } from '../middleware/error-handler';
import { orchestrationRuntimeRepository } from '../repositories/orchestration-runtime-repository';

const router = Router();

const demandIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const runIdParamsSchema = z.object({
  runId: z.string().min(1),
});

const turnIdParamsSchema = z.object({
  turnId: z.string().min(1),
});

const eventsQuerySchema = z.object({
  eventType: z.string().min(1).optional(),
  agentName: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

router.get(
  '/api/demands/:id/orchestration-runs',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = demandIdParamsSchema.parse(req.params);
    const runs = await orchestrationRuntimeRepository.listRunsByDemand(id);
    res.json({ demandId: id, runs });
  }),
);

router.get(
  '/api/orchestration-runs/:runId',
  asyncHandler(async (req: Request, res: Response) => {
    const { runId } = runIdParamsSchema.parse(req.params);
    const details = await orchestrationRuntimeRepository.getRunDetails(runId);
    if (!details) {
      throw new AppError('Orchestration run not found', 404, 'NOT_FOUND');
    }
    res.json(truncateLargePayloads(details));
  }),
);

router.get(
  '/api/orchestration-runs/:runId/turns',
  asyncHandler(async (req: Request, res: Response) => {
    const { runId } = runIdParamsSchema.parse(req.params);
    const run = await orchestrationRuntimeRepository.getRun(runId);
    if (!run) {
      throw new AppError('Orchestration run not found', 404, 'NOT_FOUND');
    }
    const turns = await orchestrationRuntimeRepository.listTurns(runId);
    res.json({ runId, turns });
  }),
);

router.get(
  '/api/orchestration-runs/:runId/events',
  asyncHandler(async (req: Request, res: Response) => {
    const { runId } = runIdParamsSchema.parse(req.params);
    const query = eventsQuerySchema.parse(req.query);
    const run = await orchestrationRuntimeRepository.getRun(runId);
    if (!run) {
      throw new AppError('Orchestration run not found', 404, 'NOT_FOUND');
    }
    const events = await orchestrationRuntimeRepository.listEvents(runId, query);
    res.json({ runId, events: truncateLargePayloads(events) });
  }),
);

router.get(
  '/api/orchestration-runs/:runId/tool-calls',
  asyncHandler(async (req: Request, res: Response) => {
    const { runId } = runIdParamsSchema.parse(req.params);
    const run = await orchestrationRuntimeRepository.getRun(runId);
    if (!run) {
      throw new AppError('Orchestration run not found', 404, 'NOT_FOUND');
    }
    const toolCalls = await orchestrationRuntimeRepository.listToolCallsByRun(runId);
    res.json({ runId, toolCalls: truncateLargePayloads(toolCalls) });
  }),
);

router.get(
  '/api/agent-turns/:turnId/tool-calls',
  asyncHandler(async (req: Request, res: Response) => {
    const { turnId } = turnIdParamsSchema.parse(req.params);
    const toolCalls = await orchestrationRuntimeRepository.listToolCallsByTurn(turnId);
    res.json({ turnId, toolCalls: truncateLargePayloads(toolCalls) });
  }),
);

function truncateLargePayloads<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item !== 'string' || item.length <= 4000) return item;
      return {
        truncated: true,
        preview: item.slice(0, 4000),
        originalLength: item.length,
      };
    }),
  ) as T;
}

export default router;
