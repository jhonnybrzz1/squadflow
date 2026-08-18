import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  adminAuthMiddleware,
  authContextMiddleware,
  canApprove,
  canOverride,
  getAuthorName,
  getOverrideAuthor,
  getUserContext,
  requireAuth,
  requireRole,
  secureAdminAuthMiddleware,
  anonymizeIp,
} from '../../server/middleware/auth-stub';

function makeMocks() {
  const req = { headers: {} } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

describe('auth-stub', () => {
  it('authContextMiddleware popula req.userContext com usuário local admin', () => {
    const { req, res, next } = makeMocks();
    authContextMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.userContext).toEqual({
      id: 'local-user',
      name: 'Local User',
      email: 'local@localhost',
      role: 'admin',
      isAuthenticated: true,
    });
  });

  it('adminAuthMiddleware, requireAuth, requireRole e secureAdminAuthMiddleware chamam next', () => {
    const { req, res, next } = makeMocks();

    adminAuthMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    requireAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(2);

    requireRole('admin')(req, res, next);
    expect(next).toHaveBeenCalledTimes(3);

    secureAdminAuthMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(4);
  });

  it('getUserContext retorna contexto local', () => {
    const { req } = makeMocks();
    expect(getUserContext(req)).toEqual({
      id: 'local-user',
      name: 'Local User',
      email: 'local@localhost',
      role: 'admin',
      isAuthenticated: true,
    });
  });

  it('getAuthorName e getOverrideAuthor usam identidade local', () => {
    const { req } = makeMocks();
    expect(getAuthorName(req)).toBe('Local User (local-user)');
    expect(getOverrideAuthor(req)).toBe('LOCAL-Override: Local User (local-user)');
  });

  it('canOverride e canApprove retornam true', () => {
    const { req } = makeMocks();
    expect(canOverride(req)).toBe(true);
    expect(canApprove(req)).toBe(true);
  });

  it('anonymizeIp anonimiza IPv4 e IPv6', () => {
    expect(anonymizeIp('192.168.1.100')).toBe('192.168.1.x');
    expect(anonymizeIp('2001:db8::1')).toBe('2001:db8::x');
    expect(anonymizeIp(undefined)).toBe('unknown');
  });
});
