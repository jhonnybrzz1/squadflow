/**
 * Demanda #10358 T2 — middleware de autenticação da plataforma pública.
 *
 * Nome deliberadamente distinto de `requireAuth` (server/middleware/auth-stub.ts,
 * um no-op para o admin local fixo) para não haver qualquer ambiguidade sobre
 * qual auth protege qual rota (ver plan.md).
 */
import type { NextFunction, Request, Response } from 'express';
import type { PlatformUser } from '@shared/schema';
import { platformAuthService } from '../services/platform-auth-service';
import { asyncHandler, UnauthorizedError } from './error-handler';

declare global {
  namespace Express {
    interface Request {
      platformUser?: PlatformUser;
    }
  }
}

const BEARER_PREFIX = 'Bearer ';

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Exige um JWT válido cujo `session_nonce` confira com o banco (T2). Diverge
 * -> 401, consistente com o teste manual do PRD (logout invalida token antigo).
 */
export const requirePlatformAuth = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const token = extractBearerToken(req);
    if (!token) {
      throw new UnauthorizedError('Token de autenticação ausente.');
    }
    const user = await platformAuthService.verifyAndLoadUser(token);
    if (!user) {
      throw new UnauthorizedError('Token inválido, expirado ou sessão encerrada.');
    }
    req.platformUser = user;
    next();
  },
);
