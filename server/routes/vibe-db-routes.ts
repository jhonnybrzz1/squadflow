/**
 * Demanda #10365 T2/T3/T4 — rotas de conexões de banco (Fatia 2B).
 *
 * POST /api/db/connections — cadastra conexão (cifra credenciais)
 * GET /api/db/connections — lista conexões ativas (sem expor credenciais)
 * DELETE /api/db/connections/:id — soft delete
 * GET /api/db/connections/:id/schema — consulta schema (queries hardcoded)
 * POST /api/db/connections/test — testa conexão sem salvar
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, AppError } from '../middleware/error-handler';
import { validateRequest } from '../middleware/validate-request';
import { requirePlatformAuth } from '../middleware/platform-auth';
import { rateLimitPlatformUser } from '../middleware/platform-rate-limits';
import { dbConnectionService } from '../services/db-connection-service';
import { dbSchemaService } from '../services/db-schema-service';

const router = Router();

const createConnectionSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100),
    dbType: z.enum(['postgresql', 'mysql', 'supabase', 'neon']),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535).optional(),
    databaseName: z.string().max(255).optional(),
    username: z.string().max(255).optional(),
    password: z.string().min(1).max(500),
  }),
});

const testConnectionSchema = z.object({
  body: z.object({
    dbType: z.enum(['postgresql', 'mysql', 'supabase', 'neon']),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535).optional(),
    databaseName: z.string().max(255).optional(),
    username: z.string().max(255).optional(),
    password: z.string().min(1).max(500),
  }),
});

router.post(
  '/api/db/connections',
  requirePlatformAuth,
  rateLimitPlatformUser,
  validateRequest(createConnectionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const conn = await dbConnectionService.create(req.platformUser!.id, req.body);
      res.status(201).json(conn);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Limite')) {
        throw new AppError(error.message, 403, 'DB_CONNECTION_LIMIT');
      }
      throw error;
    }
  }),
);

router.get(
  '/api/db/connections',
  requirePlatformAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const connections = await dbConnectionService.listByUser(req.platformUser!.id);
    res.status(200).json({ connections });
  }),
);

router.delete(
  '/api/db/connections/:id',
  requirePlatformAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) throw new AppError('ID inválido', 400, 'INVALID_ID');
    await dbConnectionService.softDelete(req.platformUser!.id, id);
    res.status(204).send();
  }),
);

router.get(
  '/api/db/connections/:id/schema',
  requirePlatformAuth,
  rateLimitPlatformUser,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) throw new AppError('ID inválido', 400, 'INVALID_ID');
    const schema = await dbSchemaService.getSchema(req.platformUser!.id, id);
    res.status(200).json(schema);
  }),
);

router.post(
  '/api/db/connections/test',
  requirePlatformAuth,
  rateLimitPlatformUser,
  validateRequest(testConnectionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await dbSchemaService.testConnection(req.body);
    res.status(200).json(result);
  }),
);

export default router;
