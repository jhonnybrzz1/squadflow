import { Router, type Request, type Response } from 'express';
import { ragSubstepMetrics } from '../services/rag-substep-metrics';
import { asyncHandler } from '../middleware/error-handler';

export const ragRoutes = Router();

// RAG substep metrics dashboard (PRD: latency diagnosis)
ragRoutes.get(
  '/metrics/rag-substeps',
  asyncHandler(async (_req: Request, res: Response) => {
    const stats = ragSubstepMetrics.getStats();
    res.json(stats);
  }),
);
