/**
 * Demanda #10367 T5 — middleware adminAuth para rotas admin futuras.
 *
 * Valida que o usuário autenticado é admin E ativo. Requer que
 * `requirePlatformAuth` já tenha rodado (usa `req.platformUser`).
 * Retorna 403 Forbidden se não for admin ou conta inativa.
 */
import type { NextFunction, Request, Response } from 'express';
import { asyncHandler, ForbiddenError } from './error-handler';

/** Exige que o usuário seja admin e ativo. Para rotas admin futuras. */
export const requirePlatformAdmin = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const user = req.platformUser;
    if (!user) {
      throw new ForbiddenError('Autenticação necessária.');
    }
    if (!user.isActive) {
      throw new ForbiddenError('Conta inativa.');
    }
    if (!user.admin) {
      throw new ForbiddenError('Acesso restrito a administradores.');
    }
    next();
  },
);
