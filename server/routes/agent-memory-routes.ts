/**
 * Demanda 10088 (item 4) — leitura paginada de `agent_memory`.
 * GET /api/agent-memory?limit=&offset=&memory_type=&source_demand_id=
 */
import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../middleware/error-handler';
import { agentMemoryService } from '../services/agent-memory-service';

const router = Router();

router.get(
  '/api/agent-memory',
  asyncHandler(async (req: Request, res: Response) => {
    const num = (v: unknown): number | undefined => {
      const n = typeof v === 'string' ? Number(v) : NaN;
      return Number.isFinite(n) ? n : undefined;
    };
    const entries = await agentMemoryService.list({
      limit: num(req.query.limit),
      offset: num(req.query.offset),
      memoryType: typeof req.query.memory_type === 'string' ? req.query.memory_type : undefined,
      sourceDemandId: num(req.query.source_demand_id),
    });
    res.json({ entries });
  }),
);

export default router;
