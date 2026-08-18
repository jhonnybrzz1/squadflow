/**
 * Demanda #10358 T1 — landing page pública / captura de waitlist.
 */
import { Router, Request, Response } from 'express';
import validator from 'validator';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error-handler';
import { validateRequest } from '../middleware/validate-request';
import { waitlistService } from '../services/waitlist-service';

const router = Router();

const waitlistSchema = z.object({
  body: z.object({
    email: z
      .string()
      .min(1, 'email é obrigatório')
      .max(320)
      .refine((value) => validator.isEmail(value), 'email inválido'),
    source: z.string().max(64).optional(),
  }),
});

router.post(
  '/api/waitlist',
  validateRequest(waitlistSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { email, source } = req.body as { email: string; source?: string };
    const { created } = await waitlistService.add(email, source);
    res.status(created ? 201 : 200).json({ ok: true, alreadyRegistered: !created });
  }),
);

export default router;
