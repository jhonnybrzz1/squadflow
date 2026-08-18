/**
 * Auth Stub Middleware
 *
 * Substitui a autenticação real para uso local/desktop. O projeto roda apenas
 * na máquina do usuário, então login/roles são desnecessários. Este stub mantém
 * a interface compatível com o restante do código, retornando um contexto
 * local fixo e permitindo que rotas de governança/admin continuem funcionando.
 *
 * Spec 011 (R-01/US2-AS2): o usuário administrativo FIXO é decisão deliberada
 * do perfil pessoal/local-first — NÃO é autenticação multiusuário incompleta.
 * Reintroduzir login/RBAC exige mudança explícita de escopo (ver constituição).
 */

import { Request, Response, NextFunction } from 'express';

// ============================================
// User Context Interface
// ============================================

export interface UserContext {
  id: string;
  name: string;
  email?: string;
  role: UserRole;
  isAuthenticated: boolean;
}

export type UserRole =
  | 'anonymous'
  | 'viewer'
  | 'reviewer'
  | 'editor'
  | 'product_manager'
  | 'tech_lead'
  | 'admin';

export const OVERRIDE_ROLES: UserRole[] = ['product_manager', 'tech_lead', 'admin'];
export const APPROVER_ROLES: UserRole[] = ['reviewer', 'product_manager', 'tech_lead', 'admin'];

const LOCAL_USER: UserContext = {
  id: 'local-user',
  name: 'Local User',
  email: 'local@localhost',
  role: 'admin',
  isAuthenticated: true,
};

// ============================================
// Request Extension
// ============================================

declare global {
  namespace Express {
    interface Request {
      userContext?: UserContext;
    }
  }
}

// ============================================
// Middleware
// ============================================

export function authContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.userContext = LOCAL_USER;
  next();
}

export function adminAuthMiddleware(_req: Request, _res: Response, next: NextFunction): void {
  next();
}

export function secureAdminAuthMiddleware(_req: Request, _res: Response, next: NextFunction): void {
  next();
}

export function requireAuth(_req: Request, _res: Response, next: NextFunction): void {
  next();
}

export function requireRole(..._roles: UserRole[]) {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    next();
  };
}

// ============================================
// Helper Functions
// ============================================

export function getUserContext(_req: Request): UserContext {
  return LOCAL_USER;
}

export function getAuthorName(_req: Request): string {
  return `${LOCAL_USER.name} (${LOCAL_USER.id})`;
}

export function getOverrideAuthor(_req: Request): string {
  return `LOCAL-Override: ${LOCAL_USER.name} (${LOCAL_USER.id})`;
}

export function canOverride(_req: Request): boolean {
  return true;
}

export function canApprove(_req: Request): boolean {
  return true;
}

export function anonymizeIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  if (/(^|:)\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.replace(/\.\d+$/, '.x');
  }
  return ip.replace(/:[^:]+$/, ':x');
}
