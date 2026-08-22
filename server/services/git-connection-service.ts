/**
 * Conexões GitHub App por usuário, com credenciais cifradas e somente leitura.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { gitConnections } from '@shared/schema-unified';
import type { GitConnection } from '@shared/schema';
import { ensureVibePlatformSchema } from './vibe-platform-schema';
import { encryptGitToken, decryptGitToken } from './git-token-cipher';

export type GitProvider = 'github';

const GITHUB_CREDENTIAL_VERSION = 1;

export interface GitHubUserCredential {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: number | null;
  refreshTokenExpiresAt: number | null;
}

interface StoredGitHubCredentialEnvelope extends GitHubUserCredential {
  kind: 'github_app_user';
  version: typeof GITHUB_CREDENTIAL_VERSION;
}

/**
 * Stores the access and refresh tokens as one encrypted value so existing
 * databases do not need a plaintext or multi-column credential migration.
 */
export function serializeGitHubCredential(credential: GitHubUserCredential): string {
  if (!credential.accessToken) throw new Error('GitHub access token is required.');
  return JSON.stringify({
    kind: 'github_app_user',
    version: GITHUB_CREDENTIAL_VERSION,
    ...credential,
  } satisfies StoredGitHubCredentialEnvelope);
}

/** Backward-compatible with OAuth/PAT values encrypted by earlier releases. */
export function deserializeGitHubCredential(value: string): GitHubUserCredential {
  if (value.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(value) as Partial<StoredGitHubCredentialEnvelope>;
      if (
        parsed.kind === 'github_app_user' &&
        parsed.version === GITHUB_CREDENTIAL_VERSION &&
        typeof parsed.accessToken === 'string' &&
        parsed.accessToken.length > 0
      ) {
        return {
          accessToken: parsed.accessToken,
          refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : null,
          accessTokenExpiresAt:
            typeof parsed.accessTokenExpiresAt === 'number' ? parsed.accessTokenExpiresAt : null,
          refreshTokenExpiresAt:
            typeof parsed.refreshTokenExpiresAt === 'number' ? parsed.refreshTokenExpiresAt : null,
        };
      }
    } catch {
      throw new Error('Stored GitHub credential envelope is not valid JSON.');
    }
    throw new Error('Stored GitHub credential envelope has an unsupported format.');
  }

  // Legacy rows contain the token itself instead of a JSON envelope.
  if (!value) throw new Error('Stored GitHub credential is empty.');
  return {
    accessToken: value,
    refreshToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  };
}

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
    credential: GitHubUserCredential;
    githubUsername: string | null;
  }): Promise<{ connection: GitConnection; created: boolean }> {
    await ensureVibePlatformSchema();
    const existing = await this.findConnection(input.userId, input.provider);
    const accessTokenEncrypted = encryptGitToken(serializeGitHubCredential(input.credential));

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
    const credential = await this.getCredential(userId, provider);
    return credential?.accessToken ?? null;
  }

  async getCredential(userId: number, provider: GitProvider): Promise<GitHubUserCredential | null> {
    const connection = await this.findConnection(userId, provider);
    if (!connection) return null;
    return deserializeGitHubCredential(decryptGitToken(connection.accessTokenEncrypted));
  }

  async updateCredential(
    userId: number,
    provider: GitProvider,
    credential: GitHubUserCredential,
  ): Promise<void> {
    await ensureVibePlatformSchema();
    const accessTokenEncrypted = encryptGitToken(serializeGitHubCredential(credential));
    await db
      .update(gitConnections)
      .set({ accessTokenEncrypted })
      .where(and(eq(gitConnections.userId, userId), eq(gitConnections.provider, provider)));
  }
}

export const gitConnectionService = new GitConnectionService();
