/**
 * GitHub App connection for the public SquadFlow surface.
 *
 * Users install the app on explicitly selected repositories. The resulting
 * user access token has the intersection of the user's permissions and the
 * app's read-only permissions; no classic OAuth `repo` scope is requested.
 */
import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { logger } from '../utils/logger';
import { AppError, ExternalServiceError, RateLimitError } from '../middleware/error-handler';
import { gitConnectionService, type GitHubUserCredential } from './git-connection-service';

const GITHUB_APPS_URL = 'https://github.com/apps';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const MAX_INSTALLATIONS = 20;
const MAX_REPOS = 100;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const GITHUB_APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/i;
const tokenRefreshInFlight = new Map<number, Promise<string>>();

const UserOctokit = Octokit.plugin(retry, throttling);

interface GitHubAppConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  slug: string;
}

interface GitHubTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function requireGitHubAppConfig(): GitHubAppConfig {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  const callbackUrl = process.env.GITHUB_APP_CALLBACK_URL;
  const slug = process.env.GITHUB_APP_SLUG;

  if (!clientId || !clientSecret || !callbackUrl || !slug) {
    throw new AppError(
      'GitHub App não configurado. Defina GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_CALLBACK_URL e GITHUB_APP_SLUG.',
      500,
      'CONFIG_ERROR',
    );
  }
  if (!GITHUB_APP_SLUG_PATTERN.test(slug)) {
    throw new AppError('GITHUB_APP_SLUG inválido.', 500, 'CONFIG_ERROR');
  }

  let parsedCallback: URL;
  try {
    parsedCallback = new URL(callbackUrl);
  } catch {
    throw new AppError('GITHUB_APP_CALLBACK_URL inválida.', 500, 'CONFIG_ERROR');
  }
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsedCallback.hostname);
  if (parsedCallback.protocol !== 'https:' && !isLoopback) {
    throw new AppError(
      'GITHUB_APP_CALLBACK_URL deve usar HTTPS, exceto em localhost.',
      500,
      'CONFIG_ERROR',
    );
  }

  return { clientId, clientSecret, callbackUrl, slug };
}

/**
 * The GitHub App must enable "Request user authorization (OAuth) during
 * installation". GitHub then performs repository selection and returns the
 * user to GITHUB_APP_CALLBACK_URL with `code` and the signed `state`.
 */
export function buildInstallUrl(state: string): string {
  const { slug } = requireGitHubAppConfig();
  const url = new URL(`${GITHUB_APPS_URL}/${slug}/installations/new`);
  url.searchParams.set('state', state);
  return url.toString();
}

function credentialFromPayload(
  payload: GitHubTokenResponse,
  now = Date.now(),
): GitHubUserCredential {
  if (!payload.access_token?.startsWith('ghu_')) {
    throw new AppError(
      'A configuração não retornou um token de usuário do GitHub App. Confirme que as credenciais pertencem a um GitHub App, não a um OAuth App.',
      502,
      'GITHUB_APP_TOKEN_INVALID',
    );
  }
  if (payload.scope?.trim()) {
    throw new AppError(
      'O GitHub retornou escopos OAuth clássicos inesperados. O SquadFlow aceita somente permissões granulares do GitHub App.',
      502,
      'GITHUB_APP_TOKEN_INVALID',
    );
  }
  if (payload.token_type && payload.token_type.toLowerCase() !== 'bearer') {
    throw new AppError(
      'Tipo de token inesperado retornado pelo GitHub.',
      502,
      'GITHUB_APP_TOKEN_INVALID',
    );
  }
  if (payload.refresh_token && !payload.refresh_token.startsWith('ghr_')) {
    throw new AppError(
      'Refresh token inesperado retornado pelo GitHub.',
      502,
      'GITHUB_APP_TOKEN_INVALID',
    );
  }

  const expiresIn = Number(payload.expires_in);
  const refreshExpiresIn = Number(payload.refresh_token_expires_in);
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || null,
    accessTokenExpiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
    refreshTokenExpiresAt:
      Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0
        ? now + refreshExpiresIn * 1000
        : null,
  };
}

async function requestUserToken(
  params: Record<string, string>,
  failureMessage: string,
): Promise<GitHubUserCredential> {
  const { clientId, clientSecret } = requireGitHubAppConfig();
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params });

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
  } catch (error) {
    throw new ExternalServiceError(
      'github-app',
      failureMessage,
      error instanceof Error ? error : undefined,
    );
  }

  const payload = (await response.json().catch(() => null)) as GitHubTokenResponse | null;
  if (!response.ok || !payload?.access_token) {
    logger.warn('Falha ao obter token de usuário do GitHub App', {
      context: { status: response.status, error: payload?.error },
    });
    throw new AppError(
      payload?.error_description || failureMessage,
      502,
      'GITHUB_APP_TOKEN_EXCHANGE_FAILED',
    );
  }

  return credentialFromPayload(payload);
}

export async function exchangeCodeForToken(code: string): Promise<GitHubUserCredential> {
  const { callbackUrl } = requireGitHubAppConfig();
  return requestUserToken(
    { code, redirect_uri: callbackUrl },
    'Não foi possível concluir a conexão com o GitHub App.',
  );
}

export async function refreshGithubUserToken(refreshToken: string): Promise<GitHubUserCredential> {
  return requestUserToken(
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    'Não foi possível renovar a conexão com o GitHub App.',
  );
}

/** Returns a cached token or rotates it shortly before its eight-hour expiry. */
export async function getValidGithubAccessToken(userId: number): Promise<string | null> {
  const credential = await gitConnectionService.getCredential(userId, 'github');
  if (!credential) return null;

  if (!credential.accessToken.startsWith('ghu_')) {
    throw new AppError(
      'Esta conexão usa OAuth clássico. Reconecte para selecionar repositórios pelo GitHub App.',
      401,
      'GITHUB_RECONNECT_REQUIRED',
    );
  }

  const now = Date.now();
  if (
    credential.accessTokenExpiresAt === null ||
    credential.accessTokenExpiresAt > now + TOKEN_REFRESH_SKEW_MS
  ) {
    return credential.accessToken;
  }

  if (
    !credential.refreshToken ||
    (credential.refreshTokenExpiresAt !== null && credential.refreshTokenExpiresAt <= now)
  ) {
    throw new AppError(
      'Sua autorização do GitHub expirou. Conecte o GitHub novamente.',
      401,
      'GITHUB_RECONNECT_REQUIRED',
    );
  }

  const existingRefresh = tokenRefreshInFlight.get(userId);
  if (existingRefresh) return existingRefresh;

  const refreshOperation = (async () => {
    const refreshed = await refreshGithubUserToken(credential.refreshToken!);
    await gitConnectionService.updateCredential(userId, 'github', refreshed);
    return refreshed.accessToken;
  })();
  tokenRefreshInFlight.set(userId, refreshOperation);
  try {
    return await refreshOperation;
  } finally {
    if (tokenRefreshInFlight.get(userId) === refreshOperation) {
      tokenRefreshInFlight.delete(userId);
    }
  }
}

function userClient(accessToken: string): Octokit {
  return new UserOctokit({ auth: accessToken });
}

export async function fetchGithubUsername(accessToken: string): Promise<string | null> {
  try {
    const { data } = await userClient(accessToken).users.getAuthenticated();
    return data.login ?? null;
  } catch (error) {
    logger.warn('Falha ao obter usuário autenticado do GitHub App', {
      error: error instanceof Error ? error : undefined,
    });
    return null;
  }
}

export interface GithubRepoSummary {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
  updatedAt: string | null;
}

/** Lists only repositories selected in installations accessible to this user. */
export async function listUserRepos(
  accessToken: string,
  client: Octokit = userClient(accessToken),
): Promise<GithubRepoSummary[]> {
  try {
    const { data: installationData } = await client.apps.listInstallationsForAuthenticatedUser({
      per_page: MAX_INSTALLATIONS,
    });
    const reposById = new Map<number, GithubRepoSummary>();

    for (const installation of installationData.installations.slice(0, MAX_INSTALLATIONS)) {
      const remaining = MAX_REPOS - reposById.size;
      if (remaining <= 0) break;
      const { data: repoData } = await client.apps.listInstallationReposForAuthenticatedUser({
        installation_id: installation.id,
        per_page: remaining,
      });
      for (const repo of repoData.repositories) {
        reposById.set(repo.id, {
          id: repo.id,
          name: repo.name,
          fullName: repo.full_name,
          private: repo.private,
          defaultBranch: repo.default_branch ?? null,
          updatedAt: repo.updated_at ?? null,
        });
      }
    }

    return [...reposById.values()].sort((a, b) =>
      (b.updatedAt || '').localeCompare(a.updatedAt || ''),
    );
  } catch (error) {
    throw toGithubApiError(error, 'Falha ao listar repositórios selecionados no GitHub App.');
  }
}

export interface GithubRepoFileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'other';
}

/** Lists root entries; GitHub rejects repositories outside the installation. */
export async function listRepoRootFiles(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<GithubRepoFileEntry[]> {
  try {
    const { data } = await userClient(accessToken).repos.getContent({ owner, repo, path: '' });
    const entries = Array.isArray(data) ? data : [data];
    return entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      type: entry.type === 'file' || entry.type === 'dir' ? entry.type : 'other',
    }));
  } catch (error) {
    throw toGithubApiError(error, `Falha ao listar arquivos de ${owner}/${repo}.`);
  }
}

function toGithubApiError(error: unknown, message: string): AppError {
  const status = (error as { status?: number })?.status;
  if (status === 403 || status === 429) {
    return new RateLimitError(
      'Limite de requisições do GitHub atingido. Tente novamente em alguns minutos.',
    );
  }
  if (status === 401) {
    return new AppError(
      'A autorização do GitHub não é mais válida. Conecte novamente.',
      401,
      'GITHUB_RECONNECT_REQUIRED',
    );
  }
  return new ExternalServiceError(
    'github-app',
    message,
    error instanceof Error ? error : undefined,
  );
}
