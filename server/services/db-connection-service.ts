/**
 * Demanda #10365 T2/T6 — serviço de conexões de banco do usuário (Fatia 2B).
 *
 * CRUD para conexões de banco (PostgreSQL, MySQL, Supabase, Neon). Credenciais
 * cifradas com AES-256-GCM (db-credential-cipher.ts). Limite de 2 conexões
 * no Free Tier, ilimitado no Pro.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { dbConnections } from '@shared/schema-unified';
import type { DbConnection } from '@shared/schema';
import { ensureVibePlatformSchema } from './vibe-platform-schema';
import { encryptDbCredentials, decryptDbCredentials } from './db-credential-cipher';
import { subscriptionService } from './subscription-service';

export type DbType = 'postgresql' | 'mysql' | 'supabase' | 'neon';

export interface DbConnectionInput {
  name: string;
  dbType: DbType;
  host: string;
  port?: number;
  databaseName?: string;
  username?: string;
  password: string; // cifrado antes de salvar
}

export interface DbConnectionView {
  id: number;
  name: string;
  dbType: string;
  host: string;
  port: number | null;
  databaseName: string | null;
  username: string | null;
  isActive: boolean;
  createdAt: Date;
}

const FREE_TIER_MAX_DB_CONNECTIONS = 2;

function toView(conn: DbConnection): DbConnectionView {
  return {
    id: conn.id,
    name: conn.name,
    dbType: conn.dbType,
    host: conn.host,
    port: conn.port,
    databaseName: conn.databaseName,
    username: conn.username,
    isActive: conn.isActive,
    createdAt: conn.createdAt,
  };
}

class DbConnectionService {
  private async ensure(): Promise<void> {
    await ensureVibePlatformSchema();
  }

  async listByUser(userId: number): Promise<DbConnectionView[]> {
    await this.ensure();
    const rows = await db
      .select()
      .from(dbConnections)
      .where(and(eq(dbConnections.userId, userId), eq(dbConnections.isActive, true)));
    return rows.map(toView);
  }

  async findById(userId: number, connectionId: number): Promise<DbConnection | null> {
    await this.ensure();
    const [row] = await db
      .select()
      .from(dbConnections)
      .where(and(eq(dbConnections.id, connectionId), eq(dbConnections.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  async countActive(userId: number): Promise<number> {
    await this.ensure();
    const rows = await db
      .select({ id: dbConnections.id })
      .from(dbConnections)
      .where(and(eq(dbConnections.userId, userId), eq(dbConnections.isActive, true)));
    return rows.length;
  }

  async create(userId: number, input: DbConnectionInput): Promise<DbConnectionView> {
    await this.ensure();

    // T6: verifica limite do Free Tier
    const activePlan = await subscriptionService.getActivePlan(userId);
    if (activePlan.plan === 'free') {
      const count = await this.countActive(userId);
      if (count >= FREE_TIER_MAX_DB_CONNECTIONS) {
        throw new Error(
          `Limite de ${FREE_TIER_MAX_DB_CONNECTIONS} conexões de banco no plano gratuito. Faça upgrade para o Pro.`,
        );
      }
    }

    const encryptedCredentials = encryptDbCredentials(input.password);

    const [row] = await db
      .insert(dbConnections)
      .values({
        userId,
        name: input.name,
        dbType: input.dbType,
        host: input.host,
        port: input.port ?? null,
        databaseName: input.databaseName ?? null,
        username: input.username ?? null,
        encryptedCredentials,
        isActive: true,
      })
      .returning();

    return toView(row);
  }

  async softDelete(userId: number, connectionId: number): Promise<void> {
    await this.ensure();
    await db
      .update(dbConnections)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(dbConnections.id, connectionId), eq(dbConnections.userId, userId)));
  }

  /** Descriptografa credenciais apenas no momento da conexão. */
  async getDecryptedPassword(userId: number, connectionId: number): Promise<string | null> {
    const conn = await this.findById(userId, connectionId);
    if (!conn || !conn.isActive) return null;
    return decryptDbCredentials(conn.encryptedCredentials);
  }
}

export const dbConnectionService = new DbConnectionService();
