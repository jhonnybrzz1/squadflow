/**
 * Demanda 10096 — API do backlog de atividades.
 *   GET   /api/backlog/activities        — lista
 *   PATCH /api/backlog/activities/:id     — transição manual de status
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error-handler';
import { toNext } from '../middleware/result-to-express';
import { backlogActivityService, BACKLOG_STATUSES } from '../services/backlog-activity-service';

const router = Router();

router.get(
  '/api/backlog/activities',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ activities: await backlogActivityService.list() });
  }),
);

const patchSchema = z.object({ status: z.enum(BACKLOG_STATUSES) });

router.patch(
  '/api/backlog/activities/:id',
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'status inválido', valid: BACKLOG_STATUSES });
      return;
    }
    const result = await backlogActivityService.transition(req.params.id, parsed.data.status);
    // Spec 10125 #16: use Result→Express wrapper. not_found → 404, invalid transition → 422.
    if (
      !toNext(result, res, next, {
        defaultStatus: 422,
        operation: 'backlog:transition',
        statusCodeForError: { not_found: 404 },
      })
    ) {
      return;
    }
    res.json(result.activity);
  }),
);

export default router;
