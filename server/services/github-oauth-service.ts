/**
 * Demanda #10358 T4 — OAuth GitHub por usuário, somente leitura.
 *
 * Troca code -> token via `fetch` nativo (Node 20+, sem dependência nova);
 * listagem de repos/arquivos via `@octokit/rest` (já é dependência do
 * projeto), instanciado por requisição com o token do PRÓPRIO usuário — nunca
 * o token de servidor usado por `server/services/github.ts` (esse é para
 * grounding do pipeline interno, propósito diferente).
 */
import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { logger } from '../utils/logger';
import { AppError, ExternalServiceError, RateLimitError } from '../middleware/error-handler';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
// Somente leitura, conforme PRD/Tasks: read:user + repo (para LISTAR repositórios,
// incluindo privados). Nenhuma rota deste módulo executa push/commit/branch.
const OAUTH_SCOPES = 'read:user repo';
const MAX_REPOS = 30;

const UserOctokit = Octokit.plugin(retry, throttling);

function requireOAuthConfig(): { clientId: string; clientSecret: string; callbackUrl: string } {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  const callbackUrl = process.env.GITHUB_OAUTH_CALLBACK_URL;
  if (!clientId || !clientSecret || !callbackUrl) {
    throw new AppError(
      'Integração GitHub não configurada (GITHUB_OAUTH_CLIENT_ID/SECRET/CALLBACK_URL ausentes).',
      500,
      'CONFIG_ERROR',
    );
  }
  return { clientId, clientSecret, callbackUrl };
}

export function isGithubOAuthConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_OAUTH_CLIENT_ID &&
    process.env.GITHUB_OAUTH_CLIENT_SECRET &&
    process.env.GITHUB_OAUTH_CALLBACK_URL,
  );
}

export function buildAuthorizeUrl(state: string): string {
  const { clientId, callbackUrl } = requireOAuthConfig();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', callbackUrl);
  url.searchParams.set('scope', OAUTH_SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeCodeForToken(code: string): Promise<string> {
  const { clientId, clientSecret, callbackUrl } = requireOAuthConfig();
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl,
      }),
    });
  } catch (error) {
    throw new ExternalServiceError(
      'github-oauth',
      'Falha ao contatar o GitHub para autenticação.',
      error instanceof Error ? error : undefined,
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  } | null;

  if (!response.ok || !payload?.access_token) {
    logger.warn('Falha na troca de code por access_token do GitHub OAuth', {
      context: { status: response.status, error: payload?.error },
    });
    throw new AppError(
      payload?.error_description || 'Não foi possível concluir a conexão com o GitHub.',
      502,
      'GITHUB_OAUTH_EXCHANGE_FAILED',
    );
  }
  return payload.access_token;
}

function userClient(accessToken: string): Octokit {
  return new UserOctokit({ auth: accessToken });
}

export async function fetchGithubUsername(accessToken: string): Promise<string | null> {
  try {
    const { data } = await userClient(accessToken).users.getAuthenticated();
    return data.login ?? null;
  } catch (error) {
    logger.warn('Falha ao obter usuário autenticado do GitHub (OAuth)', {
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

/** Lista até MAX_REPOS repositórios do usuário — bound explícito do MVP (T4). */
export async function listUserRepos(accessToken: string): Promise<GithubRepoSummary[]> {
  try {
    const { data } = await userClient(accessToken).repos.listForAuthenticatedUser({
      per_page: MAX_REPOS,
      sort: 'updated',
    });
    return data.map((repo) => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      private: repo.private,
      defaultBranch: repo.default_branch ?? null,
      updatedAt: repo.updated_at ?? null,
    }));
  } catch (error) {
    throw toGithubApiError(error, 'Falha ao listar repositórios do GitHub.');
  }
}

export interface GithubRepoFileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'other';
}

/**
 * Lista o diretório raiz do repositório (sem download de conteúdo) — usado
 * como contexto futuro do refinamento, conforme Tasks.md T4.
 */
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
  return new ExternalServiceError(
    'github-oauth',
    message,
    error instanceof Error ? error : undefined,
  );
}
