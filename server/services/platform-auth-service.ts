/**
 * Demanda #10358 T2 — autenticação real da plataforma pública (Vibe Coders).
 *
 * `bcryptjs` em vez de `bcrypt` (ver plan.md): mesma API, sem binding nativo,
 * reduzindo risco de build em sandboxes restritos. `session_nonce` em vez de
 * blacklist/refresh token — mitigação aceita pelo tech_lead no PRD para a
 * Fatia 1 (~50 betas): login gera um nonce novo, logout/comprometimento de
 * conta gera outro, invalidando todo JWT emitido antes da troca.
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { platformUsers } from '@shared/schema-unified';
import type { PlatformUser } from '@shared/schema';
import { ensureVibePlatformSchema } from './vibe-platform-schema';
import { getJwtSecret } from '../utils/platform-secrets';
import { ConflictError, UnauthorizedError, ForbiddenError } from '../middleware/error-handler';

const BCRYPT_ROUNDS = 10;
const JWT_EXPIRES_IN = '7d';

export interface PlatformAuthTokenPayload {
  userId: number;
  sessionNonce: string;
}

export type PublicPlatformUser = Omit<PlatformUser, 'passwordHash' | 'sessionNonce'>;

function toPublicUser(user: PlatformUser): PublicPlatformUser {
  const { passwordHash: _passwordHash, sessionNonce: _sessionNonce, ...publicUser } = user;
  return publicUser;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

class PlatformAuthService {
  async signup(email: string, password: string): Promise<PublicPlatformUser> {
    await ensureVibePlatformSchema();
    const normalizedEmail = normalizeEmail(email);

    const existing = await db
      .select()
      .from(platformUsers)
      .where(eq(platformUsers.email, normalizedEmail))
      .limit(1);
    if (existing[0]) {
      throw new ConflictError('Já existe uma conta com este email.');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const [user] = await db
      .insert(platformUsers)
      .values({ email: normalizedEmail, passwordHash, plan: 'free' })
      .returning();
    return toPublicUser(user);
  }

  async login(
    email: string,
    password: string,
  ): Promise<{ user: PublicPlatformUser; token: string }> {
    await ensureVibePlatformSchema();
    const normalizedEmail = normalizeEmail(email);

    const [user] = await db
      .select()
      .from(platformUsers)
      .where(eq(platformUsers.email, normalizedEmail))
      .limit(1);

    // Mensagem genérica em ambos os casos (email inexistente vs senha errada)
    // para não vazar quais emails têm conta.
    const invalidCredentials = () => new UnauthorizedError('Email ou senha inválidos.');
    if (!user) throw invalidCredentials();

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) throw invalidCredentials();

    const sessionNonce = randomUUID();
    const [updated] = await db
      .update(platformUsers)
      .set({ sessionNonce })
      .where(eq(platformUsers.id, user.id))
      .returning();

    const token = jwt.sign(
      { userId: updated.id, sessionNonce } satisfies PlatformAuthTokenPayload,
      getJwtSecret(),
      {
        expiresIn: JWT_EXPIRES_IN,
      },
    );

    return { user: toPublicUser(updated), token };
  }

  /** Gera um novo `session_nonce`, invalidando todo JWT emitido antes da troca. */
  async logout(userId: number): Promise<void> {
    await ensureVibePlatformSchema();
    await db
      .update(platformUsers)
      .set({ sessionNonce: randomUUID() })
      .where(eq(platformUsers.id, userId));
  }

  /**
   * Valida a assinatura/expiração do JWT e confere o `session_nonce` contra o
   * banco. Retorna `null` para qualquer falha (token inválido/expirado, nonce
   * divergente, usuário inexistente) — o middleware decide o 401.
   */
  async verifyAndLoadUser(token: string): Promise<PlatformUser | null> {
    await ensureVibePlatformSchema();
    let payload: PlatformAuthTokenPayload;
    try {
      payload = jwt.verify(token, getJwtSecret()) as PlatformAuthTokenPayload;
    } catch {
      return null;
    }
    if (!payload || typeof payload.userId !== 'number' || !payload.sessionNonce) return null;

    const [user] = await db
      .select()
      .from(platformUsers)
      .where(eq(platformUsers.id, payload.userId))
      .limit(1);
    if (!user || !user.sessionNonce || user.sessionNonce !== payload.sessionNonce) {
      return null;
    }
    // #10367: contas soft-deletadas (isActive=false) não podem autenticar.
    if (!user.isActive) {
      return null;
    }
    return user;
  }

  /**
   * Demanda #10367 T1 — atualiza email e/ou senha do perfil.
   * Troca de senha requer currentPassword válida (bcrypt compare).
   * Email troca direto (sem senha). Nova senha: mínimo 8 chars, 1 uppercase, 1 number.
   */
  async updateProfile(
    userId: number,
    input: { email?: string; currentPassword?: string; newPassword?: string },
  ): Promise<PublicPlatformUser> {
    await ensureVibePlatformSchema();
    const [user] = await db
      .select()
      .from(platformUsers)
      .where(eq(platformUsers.id, userId))
      .limit(1);
    if (!user) throw new UnauthorizedError('Usuário não encontrado.');

    const updates: Partial<PlatformUser> = {};

    if (input.email) {
      const normalizedEmail = normalizeEmail(input.email);
      // Verifica se email já existe (exceto o próprio)
      const existing = await db
        .select()
        .from(platformUsers)
        .where(eq(platformUsers.email, normalizedEmail))
        .limit(1);
      if (existing[0] && existing[0].id !== userId) {
        throw new ConflictError('Já existe uma conta com este email.');
      }
      updates.email = normalizedEmail;
    }

    if (input.newPassword) {
      if (!input.currentPassword) {
        throw new UnauthorizedError('Senha atual é obrigatória para trocar a senha.');
      }
      const passwordMatches = await bcrypt.compare(input.currentPassword, user.passwordHash);
      if (!passwordMatches) {
        throw new UnauthorizedError('Senha atual inválida.');
      }
      // Validação de força: mínimo 8 chars, 1 uppercase, 1 number
      if (input.newPassword.length < 8) {
        throw new ForbiddenError('Nova senha deve ter no mínimo 8 caracteres.');
      }
      if (!/[A-Z]/.test(input.newPassword)) {
        throw new ForbiddenError('Nova senha deve conter pelo menos 1 letra maiúscula.');
      }
      if (!/[0-9]/.test(input.newPassword)) {
        throw new ForbiddenError('Nova senha deve conter pelo menos 1 número.');
      }
      updates.passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);
      // Troca de senha invalida sessões anteriores (nonce novo)
      updates.sessionNonce = randomUUID();
    }

    if (Object.keys(updates).length === 0) {
      return toPublicUser(user);
    }

    const [updated] = await db
      .update(platformUsers)
      .set(updates)
      .where(eq(platformUsers.id, userId))
      .returning();
    return toPublicUser(updated);
  }

  /**
   * Demanda #10367 T3 — soft delete de conta.
   * Anonimiza email, define isActive=false e deletedAt=now().
   * Usage counters preservados (sem cascade) para analytics agregados.
   */
  async softDeleteAccount(userId: number): Promise<void> {
    await ensureVibePlatformSchema();
    await db
      .update(platformUsers)
      .set({
        email: `deleted_${userId}@removed`,
        isActive: false,
        deletedAt: new Date(),
        sessionNonce: randomUUID(), // invalida todo JWT existente
      })
      .where(eq(platformUsers.id, userId));
  }
}

export const platformAuthService = new PlatformAuthService();
export { toPublicUser };
