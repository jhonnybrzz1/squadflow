/**
 * Demanda #10358 — cliente HTTP da plataforma pública (Vibe Coders).
 *
 * Módulo dedicado (em vez de estender `apiRequest` em `queryClient.ts`): as
 * rotas novas usam Bearer JWT em vez do cookie de sessão administrativo, e
 * mantê-lo isolado evita qualquer risco de mudar o comportamento das
 * chamadas existentes do painel interno. Reaproveita `apiErrorFromResponse`
 * para manter o mesmo formato de erro em toda a aplicação.
 */
import { apiErrorFromResponse } from './api-error';

const TOKEN_STORAGE_KEY = 'vibe.auth.token';

export function getStoredVibeToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredVibeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // localStorage indisponível (modo privado etc.) — sessão só dura a aba atual.
  }
}

async function vibeFetch(method: string, path: string, body?: unknown): Promise<Response> {
  const token = getStoredVibeToken();
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: method === 'GET' ? 'no-store' : 'default',
  });

  if (!res.ok) throw await apiErrorFromResponse(res);
  return res;
}

export interface VibeUser {
  id: number;
  email: string;
  plan: string;
  createdAt: string | number;
}

export interface VibeRefinementResult {
  refinedDescription: string;
  suggestedTasks: string[];
  estimatedComplexity: string;
}

export interface VibeUsage {
  refinementsUsed: number;
  refinementsLimit: number;
  reposUsed: number;
  reposLimit: number;
  hasFullHistory: boolean;
  plan: 'free' | 'pro';
}

export interface VibePlan {
  plan: 'free' | 'pro';
  status: string;
  currentPeriodEnd: string | number | null;
  cancelAtPeriodEnd: boolean;
  limits: {
    refinements: { used: number; max: number };
    gitRepos: { used: number; max: number };
    hasFullHistory: boolean;
  };
}

export interface VibeRepo {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
  updatedAt: string | null;
}

export interface VibeDbConnection {
  id: number;
  name: string;
  dbType: string;
  host: string;
  port: number | null;
  databaseName: string | null;
  username: string | null;
  isActive: boolean;
  createdAt: string | number;
}

export interface VibeDbSchema {
  tables: { name: string; columns: { name: string; type: string; nullable: boolean }[] }[];
  truncated: boolean;
}

export interface VibePreviewResult {
  suggestedFeatures: string[];
  architectureNotes: string;
  potentialBugs: string[];
  estimatedEffort: string;
}

export const vibeApi = {
  waitlist: {
    join: (email: string, source?: string) =>
      vibeFetch('POST', '/api/waitlist', { email, source }).then(
        (r) => r.json() as Promise<{ ok: true; alreadyRegistered: boolean }>,
      ),
  },
  auth: {
    signup: (email: string, password: string) =>
      vibeFetch('POST', '/api/auth/signup', { email, password }).then(
        (r) => r.json() as Promise<{ user: VibeUser }>,
      ),
    login: (email: string, password: string) =>
      vibeFetch('POST', '/api/auth/login', { email, password }).then(
        (r) => r.json() as Promise<{ user: VibeUser; token: string }>,
      ),
    logout: () => vibeFetch('POST', '/api/auth/logout'),
    updateProfile: (input: { email?: string; currentPassword?: string; newPassword?: string }) =>
      vibeFetch('PATCH', '/api/auth/me', input).then(
        (r) => r.json() as Promise<{ user: VibeUser }>,
      ),
    deleteAccount: () => vibeFetch('DELETE', '/api/auth/me'),
    deleteGitConnection: (id: number) => vibeFetch('DELETE', `/api/git/connections/${id}`),
  },
  refinements: {
    create: (input: {
      prompt: string;
      stack?: string;
      projectType?: string;
      repoContext?: string;
      dbConnectionId?: number;
    }) =>
      vibeFetch('POST', '/api/refinements', input).then(
        (r) => r.json() as Promise<VibeRefinementResult>,
      ),
  },
  usage: {
    get: () => vibeFetch('GET', '/api/usage').then((r) => r.json() as Promise<VibeUsage>),
  },
  plan: {
    get: () => vibeFetch('GET', '/api/me/plan').then((r) => r.json() as Promise<VibePlan>),
  },
  git: {
    getAuthorizeUrl: () =>
      vibeFetch('GET', '/api/git/auth/github').then(
        (r) => r.json() as Promise<{ authorizeUrl: string }>,
      ),
    listRepos: () =>
      vibeFetch('GET', '/api/git/repos').then((r) => r.json() as Promise<{ repos: VibeRepo[] }>),
    createPreview: (owner: string, repo: string) =>
      vibeFetch('POST', `/api/git/repos/${owner}/${repo}/preview`).then(
        (r) => r.json() as Promise<{ jobId: string; status: string }>,
      ),
    getPreviewStatus: (owner: string, repo: string, jobId: string) =>
      vibeFetch('GET', `/api/git/repos/${owner}/${repo}/preview/${jobId}`).then(
        (r) =>
          r.json() as Promise<{
            status: string;
            result: VibePreviewResult | null;
            error: string | null;
          }>,
      ),
  },
  db: {
    listConnections: () =>
      vibeFetch('GET', '/api/db/connections').then(
        (r) => r.json() as Promise<{ connections: VibeDbConnection[] }>,
      ),
    createConnection: (input: {
      name: string;
      dbType: string;
      host: string;
      port?: number;
      databaseName?: string;
      username?: string;
      password: string;
    }) =>
      vibeFetch('POST', '/api/db/connections', input).then(
        (r) => r.json() as Promise<VibeDbConnection>,
      ),
    deleteConnection: (id: number) => vibeFetch('DELETE', `/api/db/connections/${id}`),
    getSchema: (id: number) =>
      vibeFetch('GET', `/api/db/connections/${id}/schema`).then(
        (r) => r.json() as Promise<VibeDbSchema>,
      ),
    testConnection: (input: {
      dbType: string;
      host: string;
      port?: number;
      databaseName?: string;
      username?: string;
      password: string;
    }) =>
      vibeFetch('POST', '/api/db/connections/test', input).then(
        (r) => r.json() as Promise<{ success: boolean; error?: string }>,
      ),
  },
  analytics: {
    logPlatformOpened: () => vibeFetch('POST', '/api/analytics/platform-opened'),
  },
};
