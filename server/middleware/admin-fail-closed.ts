/**
 * Demanda 10217: middleware fail-closed para rotas administrativas.
 *
 * Quando o servidor binda em endereço não-loopback, rotas /api/admin,
 * /api/billing, /api/governance e /admin exigem ADMIN_API_KEY via header
 * Authorization. Bind loopback permite acesso livre para desenvolvimento local.
 */
import type { Request, Response, NextFunction } from 'express';
import { verifyAdminApiKey } from '../utils/admin-api-key';

const ADMIN_PREFIXES = ['/api/admin', '/api/billing', '/api/governance', '/admin'];

let loopbackFlag: boolean | null = null;

export function setAdminLoopbackFlag(isLoopback: boolean): void {
  loopbackFlag = isLoopback;
}

export function getAdminLoopbackFlag(): boolean | null {
  return loopbackFlag;
}

function isAdminRoute(path: string): boolean {
  return ADMIN_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function adminFailClosedMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isAdminRoute(req.path)) {
    next();
    return;
  }

  // Antes do listening callback a flag é null: fail-closed.
  if (loopbackFlag === null) {
    res.status(403).json({ error: 'ADMIN_API_KEY_REQUIRED' });
    return;
  }

  if (loopbackFlag) {
    next();
    return;
  }

  if (verifyAdminApiKey(req.headers.authorization)) {
    next();
    return;
  }

  res.status(403).json({ error: 'ADMIN_API_KEY_REQUIRED' });
}
