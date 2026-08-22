import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import {
  buildInstallUrl,
  exchangeCodeForToken,
  getValidGithubAccessToken,
  listUserRepos,
  refreshGithubUserToken,
} from '../../server/services/github-oauth-service';
import {
  deserializeGitHubCredential,
  gitConnectionService,
  serializeGitHubCredential,
} from '../../server/services/git-connection-service';
import { platformAuthService } from '../../server/services/platform-auth-service';
import vibeGitRouter from '../../server/routes/vibe-git-routes';
import { errorHandler } from '../../server/middleware/error-handler';

const ENV_KEYS = [
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_CALLBACK_URL',
  'GITHUB_APP_SLUG',
  'JWT_SECRET',
] as const;

describe('GitHub App authentication', () => {
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    process.env.GITHUB_APP_CLIENT_ID = 'Iv1.test-client';
    process.env.GITHUB_APP_CLIENT_SECRET = 'test-client-secret';
    process.env.GITHUB_APP_CALLBACK_URL = 'http://127.0.0.1:5000/api/git/auth/github/callback';
    process.env.GITHUB_APP_SLUG = 'squadflow-local';
    process.env.JWT_SECRET = 'github-app-test-jwt-secret-32-chars';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('starts at the GitHub App installation page with signed state and no OAuth scopes', () => {
    const url = new URL(buildInstallUrl('signed-state-value'));

    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/apps/squadflow-local/installations/new');
    expect(url.searchParams.get('state')).toBe('signed-state-value');
    expect(url.searchParams.has('scope')).toBe(false);
  });

  it('returns the installation URL only to an authenticated SquadFlow user', async () => {
    vi.spyOn(platformAuthService, 'verifyAndLoadUser').mockResolvedValue({ id: 42 } as never);
    const app = express();
    app.use(vibeGitRouter);
    app.use(errorHandler);

    const response = await request(app)
      .get('/api/git/auth/github')
      .set('Authorization', 'Bearer platform-session')
      .expect(200);

    const connectUrl = new URL(response.body.connectUrl as string);
    const state = connectUrl.searchParams.get('state');
    expect(connectUrl.pathname).toBe('/apps/squadflow-local/installations/new');
    expect(state).toBeTruthy();
    expect(jwt.verify(state!, process.env.JWT_SECRET!)).toMatchObject({
      purpose: 'vibe_git_oauth_state',
      userId: 42,
    });
  });

  it('accepts only fine-grained GitHub App user tokens and records expiration', async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'ghu_access',
          expires_in: 28_800,
          refresh_token: 'ghr_refresh',
          refresh_token_expires_in: 15_897_600,
          scope: '',
          token_type: 'bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const credential = await exchangeCodeForToken('temporary-code');

    expect(credential).toEqual({
      accessToken: 'ghu_access',
      refreshToken: 'ghr_refresh',
      accessTokenExpiresAt: now + 28_800_000,
      refreshTokenExpiresAt: now + 15_897_600_000,
    });
    const request = fetchMock.mock.calls[0];
    const body = request[1]?.body as URLSearchParams;
    expect(body.get('code')).toBe('temporary-code');
    expect(body.get('scope')).toBeNull();
  });

  it('rejects a classic OAuth token even when the token endpoint returns success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'gho_broad_token', scope: 'repo' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(exchangeCodeForToken('temporary-code')).rejects.toMatchObject({
      errorCode: 'GITHUB_APP_TOKEN_INVALID',
    });
  });

  it('rotates expiring tokens with the refresh-token grant', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'ghu_rotated', scope: '' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const credential = await refreshGithubUserToken('ghr_old');

    expect(credential.accessToken).toBe('ghu_rotated');
    const body = fetchMock.mock.calls[0][1]?.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('ghr_old');
  });

  it('coalesces concurrent refreshes so a one-time refresh token is consumed once', async () => {
    vi.spyOn(gitConnectionService, 'getCredential').mockResolvedValue({
      accessToken: 'ghu_expired',
      refreshToken: 'ghr_once',
      accessTokenExpiresAt: Date.now() - 1,
      refreshTokenExpiresAt: Date.now() + 60_000,
    });
    const updateCredential = vi.spyOn(gitConnectionService, 'updateCredential').mockResolvedValue();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'ghu_rotated', scope: '' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const tokens = await Promise.all([
      getValidGithubAccessToken(42),
      getValidGithubAccessToken(42),
    ]);

    expect(tokens).toEqual(['ghu_rotated', 'ghu_rotated']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateCredential).toHaveBeenCalledTimes(1);
  });

  it('requires legacy OAuth connections to reconnect through the GitHub App', async () => {
    vi.spyOn(gitConnectionService, 'getCredential').mockResolvedValue({
      accessToken: 'gho_legacy',
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    });

    await expect(getValidGithubAccessToken(42)).rejects.toMatchObject({
      errorCode: 'GITHUB_RECONNECT_REQUIRED',
    });
  });

  it('lists only repositories exposed by accessible GitHub App installations', async () => {
    const listInstallations = vi.fn().mockResolvedValue({
      data: { installations: [{ id: 10 }, { id: 20 }] },
    });
    const listInstallationRepos = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          repositories: [
            {
              id: 1,
              name: 'alpha',
              full_name: 'owner/alpha',
              private: true,
              default_branch: 'main',
              updated_at: '2026-08-20T00:00:00Z',
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          repositories: [
            {
              id: 2,
              name: 'beta',
              full_name: 'org/beta',
              private: false,
              default_branch: 'trunk',
              updated_at: '2026-08-21T00:00:00Z',
            },
          ],
        },
      });
    const client = {
      apps: {
        listInstallationsForAuthenticatedUser: listInstallations,
        listInstallationReposForAuthenticatedUser: listInstallationRepos,
      },
    } as unknown as Octokit;

    const repos = await listUserRepos('ghu_access', client);

    expect(repos.map((repo) => repo.fullName)).toEqual(['org/beta', 'owner/alpha']);
    expect(listInstallations).toHaveBeenCalledWith({ per_page: 20 });
    expect(listInstallationRepos).toHaveBeenNthCalledWith(1, {
      installation_id: 10,
      per_page: 100,
    });
    expect(listInstallationRepos).toHaveBeenNthCalledWith(2, {
      installation_id: 20,
      per_page: 99,
    });
  });

  it('bounds repository reads before requesting another installation', async () => {
    const repositories = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `repo-${index}`,
      full_name: `owner/repo-${index}`,
      private: false,
      default_branch: 'main',
      updated_at: '2026-08-20T00:00:00Z',
    }));
    const listInstallationRepos = vi.fn().mockResolvedValue({
      data: { repositories },
    });
    const client = {
      apps: {
        listInstallationsForAuthenticatedUser: vi.fn().mockResolvedValue({
          data: { installations: [{ id: 10 }, { id: 20 }] },
        }),
        listInstallationReposForAuthenticatedUser: listInstallationRepos,
      },
    } as unknown as Octokit;

    const repos = await listUserRepos('ghu_access', client);

    expect(repos).toHaveLength(100);
    expect(listInstallationRepos).toHaveBeenCalledTimes(1);
  });

  it('stores refresh metadata in the encrypted credential envelope and reads legacy rows', () => {
    const credential = {
      accessToken: 'ghu_access',
      refreshToken: 'ghr_refresh',
      accessTokenExpiresAt: 123,
      refreshTokenExpiresAt: 456,
    };

    expect(deserializeGitHubCredential(serializeGitHubCredential(credential))).toEqual(credential);
    expect(deserializeGitHubCredential('gho_legacy')).toEqual({
      accessToken: 'gho_legacy',
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    });
    expect(() => deserializeGitHubCredential('{"version":999}')).toThrow('unsupported format');
  });
});
