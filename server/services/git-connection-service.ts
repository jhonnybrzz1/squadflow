/**
 * Demanda #10358 T4 — conexões Git por usuário (OAuth GitHub, somente leitura).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { gitConnections } from '@shared/schema-unified';
import type { GitConnection } from '@shared/schema';
import { ensureVibePlatformSchema } from './vibe-platform-schema';
import { encryptGitToken, decryptGitToken } from './git-token-cipher';

export type GitProvider = 'github';

class GitConnectionService {
  async findConnection(userId: number, provider: GitProvider): Promise<GitConnection | undefined> {
    await ensureVibePlatformSchema();
    const [row] = await db
      .select()
      .from(gitConnections)
      .where(and(eq(gitConnections.userId, userId), eq(gitConnections.provider, provider)))
      .limit(1);
    return row;
  }

  async hasConnection(userId: number, provider: GitProvider): Promise<boolean> {
    return Boolean(await this.findConnection(userId, provider));
  }

  /** Demanda #10364 T3 — conta conexões ativas do usuário (para /api/me/plan). */
  async countConnections(userId: number): Promise<number> {
    await ensureVibePlatformSchema();
    const rows = await db
      .select({ id: gitConnections.id })
      .from(gitConnections)
      .where(eq(gitConnections.userId, userId));
    return rows.length;
  }

  /**
   * Cria ou atualiza (renovação de token) a conexão. Retorna `created: false`
   * quando já existia — usado para não penalizar reconexão contra o Free Tier
   * (ver checkFreeTierForGitConnect).
   */
  async upsertConnection(input: {
    userId: number;
    provider: GitProvider;
    accessToken: string;
    githubUsername: string | null;
  }): Promise<{ connection: GitConnection; created: boolean }> {
    await ensureVibePlatformSchema();
    const existing = await this.findConnection(input.userId, input.provider);
    const accessTokenEncrypted = encryptGitToken(input.accessToken);

    if (existing) {
      const [updated] = await db
        .update(gitConnections)
        .set({ accessTokenEncrypted, githubUsername: input.githubUsername })
        .where(eq(gitConnections.id, existing.id))
        .returning();
      return { connection: updated, created: false };
    }

    const [created] = await db
      .insert(gitConnections)
      .values({
        userId: input.userId,
        provider: input.provider,
        accessTokenEncrypted,
        githubUsername: input.githubUsername,
      })
      .returning();
    return { connection: created, created: true };
  }

  async getDecryptedToken(userId: number, provider: GitProvider): Promise<string | null> {
    const connection = await this.findConnection(userId, provider);
    if (!connection) return null;
    return decryptGitToken(connection.accessTokenEncrypted);
  }
}

export const gitConnectionService = new GitConnectionService();
