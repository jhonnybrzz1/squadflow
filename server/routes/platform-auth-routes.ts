/**
 * Demanda #10358 T2 — rotas de autenticação da plataforma pública.
 * Demanda #10367 T1/T2/T3 — PATCH/DELETE /api/auth/me + DELETE /api/git/connections/:id.
 */
import { Router, Request, Response } from 'express';
import validator from 'validator';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { asyncHandler, AppError } from '../middleware/error-handler';
import { validateRequest } from '../middleware/validate-request';
import { requirePlatformAuth } from '../middleware/platform-auth';
import { rateLimitPlatformAuthByIp } from '../middleware/platform-rate-limits';
import { platformAuthService } from '../services/platform-auth-service';
import { db } from '../db';
import { gitConnections } from '@shared/schema-unified';

const router = Router();

router.use(rateLimitPlatformAuthByIp);

const credentialsSchema = z.object({
  body: z.object({
    email: z
      .string()
      .min(1, 'email é obrigatório')
      .max(320)
      .refine((value) => validator.isEmail(value), 'email inválido'),
    // NIST SP 800-63B: comprimento mínimo em vez de regras de composição.
    password: z.string().min(8, 'senha deve ter no mínimo 8 caracteres').max(256),
  }),
});

router.post(
  '/api/auth/signup',
  validateRequest(credentialsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body as { email: string; password: string };
    const user = await platformAuthService.signup(email, password);
    res.status(201).json({ user });
  }),
);

router.post(
  '/api/auth/login',
  validateRequest(credentialsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body as { email: string; password: string };
    const { user, token } = await platformAuthService.login(email, password);
    res.status(200).json({ user, token });
  }),
);

router.post(
  '/api/auth/logout',
  requirePlatformAuth,
  asyncHandler(async (req: Request, res: Response) => {
    await platformAuthService.logout(req.platformUser!.id);
    res.status(200).json({ ok: true });
  }),
);

// Demanda #10367 T1 — PATCH /api/auth/me: atualizar email e/ou senha
const updateProfileSchema = z.object({
  body: z.object({
    email: z
      .string()
      .max(320)
      .refine((value) => validator.isEmail(value), 'email inválido')
      .optional(),
    currentPassword: z.string().max(256).optional(),
    newPassword: z.string().min(8).max(256).optional(),
  }),
});

router.patch(
  '/api/auth/me',
  requirePlatformAuth,
  validateRequest(updateProfileSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { email, currentPassword, newPassword } = req.body as {
      email?: string;
      currentPassword?: string;
      newPassword?: string;
    };
    const user = await platformAuthService.updateProfile(req.platformUser!.id, {
      email,
      currentPassword,
      newPassword,
    });
    res.status(200).json({ user });
  }),
);

// Demanda #10367 T2 — DELETE /api/git/connections/:id: desconectar Git
router.delete(
  '/api/git/connections/:id',
  requirePlatformAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) throw new AppError('ID inválido', 400, 'INVALID_ID');
    const userId = req.platformUser!.id;
    // Valida que a conexão pertence ao usuário
    const [conn] = await db
      .select()
      .from(gitConnections)
      .where(and(eq(gitConnections.id, id), eq(gitConnections.userId, userId)))
      .limit(1);
    if (!conn) {
      throw new AppError('Conexão não encontrada', 404, 'CONNECTION_NOT_FOUND');
    }
    await db.delete(gitConnections).where(eq(gitConnections.id, id));
    res.status(204).send();
  }),
);

// Demanda #10367 T3 — DELETE /api/auth/me: soft delete de conta
router.delete(
  '/api/auth/me',
  requirePlatformAuth,
  asyncHandler(async (req: Request, res: Response) => {
    await platformAuthService.softDeleteAccount(req.platformUser!.id);
    res.status(204).send();
  }),
);

export default router;
